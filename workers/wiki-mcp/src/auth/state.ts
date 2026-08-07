import { DurableObject } from "cloudflare:workers";
import type { RuntimeEnv } from "../vfs.js";
import type { IiPermission } from "./internet-identity.js";
import type { EncryptedValueV1 } from "./crypto.js";
import { randomOpaque, sha256 } from "./crypto.js";

const RECORD_KEY = "record";
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_CLIENT_IDLE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SPENT_REFRESH_TOKENS = 64;

export type ClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export type OAuthClientRecordV2 = {
  version: 2;
  kind: "oauth_client";
  clientId: string;
  redirectUris: string[];
  grantTypes: Array<"authorization_code" | "refresh_token">;
  tokenEndpointAuthMethod: ClientAuthMethod;
  clientSecretHash: string | null;
  createdAt: number;
  lastUsedAt: number;
  clientExpiresAt: number;
};

export type AuthorizationSessionRecordV3 = {
  version: 3;
  kind: "authorization_session";
  phase: "pending" | "redeeming" | "authorized" | "active" | "invalid";
  sessionId: string;
  clientId: string;
  redirectUri: string;
  oauthState: string;
  scope: string;
  resource: string;
  codeChallenge: string;
  connectStateHash: string;
  cookieHash: string;
  registrationKey: EncryptedValueV1 | null;
  sessionKey: EncryptedValueV1;
  pendingCodeHash: string | null;
  consumedCodeHash: string | null;
  accessTokenHash: string | null;
  accessTokenExpiresAt: number | null;
  currentRefreshTokenHash: string | null;
  spentRefreshTokenHashes: string[];
  createdAt: number;
  sessionCapAt: number;
  connectExpiresAt: number;
  authorizationCodeExpiresAt: number | null;
  sessionExpiresAt: number | null;
  iiPermission: IiPermission | null;
};

export type AuthStateRecordV3 = OAuthClientRecordV2 | AuthorizationSessionRecordV3;

export type AuthorizationSessionInput = Omit<
  AuthorizationSessionRecordV3,
  | "version"
  | "kind"
  | "phase"
  | "pendingCodeHash"
  | "consumedCodeHash"
  | "accessTokenHash"
  | "accessTokenExpiresAt"
  | "currentRefreshTokenHash"
  | "spentRefreshTokenHashes"
  | "authorizationCodeExpiresAt"
  | "sessionExpiresAt"
  | "iiPermission"
>;

export type TokenIssueResult = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number;
  sessionExpiresAt: number;
  scope: string;
  resource: string;
  encryptedSessionKey: EncryptedValueV1;
};

type TokenOperationResult =
  | { kind: "issued"; value: TokenIssueResult }
  | { kind: "invalid" }
  | { kind: "replay" };

export class McpAuthStateV3 extends DurableObject<RuntimeEnv> {
  async createClient(record: OAuthClientRecordV2): Promise<boolean> {
    const existing = await this.ctx.storage.get<AuthStateRecordV3>(RECORD_KEY);
    if (existing) {
      return false;
    }
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.setAlarm(record.clientExpiresAt);
    return true;
  }

  async getClient(now: number): Promise<OAuthClientRecordV2 | null> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV3>(RECORD_KEY);
      if (record?.kind !== "oauth_client") {
        return { client: null, expired: false };
      }
      if (record.clientExpiresAt <= now) {
        record.clientExpiresAt = now;
        await transaction.put(RECORD_KEY, record);
        return { client: null, expired: true };
      }
      record.lastUsedAt = now;
      record.clientExpiresAt = now + OAUTH_CLIENT_IDLE_TTL_MS;
      await transaction.put(RECORD_KEY, record);
      return { client: record, expired: false };
    });
    if (result.expired) {
      await this.invalidate();
      return null;
    }
    if (result.client) {
      await this.ctx.storage.setAlarm(result.client.clientExpiresAt);
    }
    return result.client;
  }

  async createSession(input: AuthorizationSessionInput): Promise<boolean> {
    const existing = await this.ctx.storage.get<AuthStateRecordV3>(RECORD_KEY);
    if (existing) {
      return false;
    }
    const record: AuthorizationSessionRecordV3 = {
      ...input,
      version: 3,
      kind: "authorization_session",
      phase: "pending",
      pendingCodeHash: null,
      consumedCodeHash: null,
      accessTokenHash: null,
      accessTokenExpiresAt: null,
      currentRefreshTokenHash: null,
      spentRefreshTokenHashes: [],
      authorizationCodeExpiresAt: null,
      sessionExpiresAt: null,
      iiPermission: null
    };
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.setAlarm(record.connectExpiresAt);
    return true;
  }

  async claimConnect(connectState: string, cookie: string, now: number): Promise<AuthorizationSessionRecordV3 | null> {
    const connectStateHash = await sha256(connectState);
    const cookieHash = await sha256(cookie);
    const consumedHash = await sha256(randomOpaque());
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV3>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "pending" ||
        record.connectExpiresAt <= now ||
        !hashEquals(record.connectStateHash, connectStateHash) ||
        !hashEquals(record.cookieHash, cookieHash)
      ) {
        return null;
      }
      record.phase = "redeeming";
      record.connectStateHash = consumedHash;
      record.cookieHash = consumedHash;
      await transaction.put(RECORD_KEY, record);
      return record;
    });
  }

  async completeConnect(
    grantExpiresAt: number,
    iiPermission: IiPermission,
    now: number,
    expectedSessionId: string
  ): Promise<{ code: string; redirectUri: string; oauthState: string } | null> {
    const code = `mkc1.${expectedSessionId}.${randomOpaque()}`;
    const pendingCodeHash = await sha256(code);
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV3>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "redeeming" ||
        record.connectExpiresAt <= now ||
        record.sessionId !== expectedSessionId
      ) {
        return null;
      }
      const sessionExpiresAt = Math.min(record.sessionCapAt, grantExpiresAt);
      if (sessionExpiresAt <= now) {
        record.phase = "invalid";
        await transaction.put(RECORD_KEY, record);
        return null;
      }
      record.pendingCodeHash = pendingCodeHash;
      record.registrationKey = null;
      record.authorizationCodeExpiresAt = Math.min(now + AUTHORIZATION_CODE_TTL_MS, sessionExpiresAt);
      record.sessionExpiresAt = sessionExpiresAt;
      record.iiPermission = iiPermission;
      if (iiPermission === "queries") {
        record.scope = record.scope
          .split(/\s+/)
          .filter((scope) => scope && scope !== "mcp:write")
          .join(" ");
      }
      record.phase = "authorized";
      await transaction.put(RECORD_KEY, record);
      return {
        code,
        redirectUri: record.redirectUri,
        oauthState: record.oauthState,
        authorizationCodeExpiresAt: record.authorizationCodeExpiresAt
      };
    });
    if (result) {
      await this.ctx.storage.setAlarm(result.authorizationCodeExpiresAt);
    }
    return result;
  }

  async exchangeCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    issueRefreshToken: boolean;
    now: number;
  }): Promise<TokenIssueResult | null> {
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier)) {
      return null;
    }
    const codeHash = await sha256(input.code);
    const verifierChallenge = await sha256(input.codeVerifier);
    const material = await createTokenMaterial(routeId(input.code), input.issueRefreshToken, input.now);
    const result = await this.ctx.storage.transaction<TokenOperationResult>(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV3>(RECORD_KEY);
      if (record?.kind !== "authorization_session") {
        return { kind: "invalid" };
      }
      const requestMatchesSession =
        record.clientId === input.clientId &&
        record.redirectUri === input.redirectUri &&
        hashEquals(record.codeChallenge, verifierChallenge);
      if (
        record.phase === "active" &&
        record.sessionExpiresAt !== null &&
        record.sessionExpiresAt > input.now &&
        record.consumedCodeHash &&
        hashEquals(record.consumedCodeHash, codeHash) &&
        requestMatchesSession
      ) {
        record.phase = "invalid";
        await transaction.put(RECORD_KEY, record);
        return { kind: "replay" };
      }
      if (
        record.phase !== "authorized" ||
        !record.pendingCodeHash ||
        !record.authorizationCodeExpiresAt ||
        record.authorizationCodeExpiresAt <= input.now ||
        !record.sessionExpiresAt ||
        record.sessionExpiresAt <= input.now ||
        !requestMatchesSession ||
        !hashEquals(record.pendingCodeHash, codeHash)
      ) {
        return { kind: "invalid" };
      }
      return {
        kind: "issued",
        value: await storeInitialTokens(transaction, record, material, input.issueRefreshToken)
      };
    });
    if (result.kind === "replay") {
      await this.invalidate();
      return null;
    }
    if (result.kind === "issued") {
      await this.ctx.storage.setAlarm(result.value.sessionExpiresAt);
      return result.value;
    }
    return null;
  }

  async rotateRefreshToken(input: { refreshToken: string; clientId: string; resource: string; now: number }): Promise<TokenIssueResult | null> {
    const refreshTokenHash = await sha256(input.refreshToken);
    const material = await createTokenMaterial(routeId(input.refreshToken), true, input.now);
    const result = await this.ctx.storage.transaction<TokenOperationResult>(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV3>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "active" ||
        !record.sessionExpiresAt ||
        record.sessionExpiresAt <= input.now ||
        record.clientId !== input.clientId ||
        record.resource !== input.resource
      ) {
        return { kind: "invalid" };
      }
      if (record.spentRefreshTokenHashes.some((hash) => hashEquals(hash, refreshTokenHash))) {
        record.phase = "invalid";
        await transaction.put(RECORD_KEY, record);
        return { kind: "replay" };
      }
      if (!record.currentRefreshTokenHash || !hashEquals(record.currentRefreshTokenHash, refreshTokenHash)) {
        return { kind: "invalid" };
      }
      if (record.spentRefreshTokenHashes.length >= MAX_SPENT_REFRESH_TOKENS) {
        record.phase = "invalid";
        await transaction.put(RECORD_KEY, record);
        return { kind: "replay" };
      }
      return {
        kind: "issued",
        value: await storeRotatedTokens(transaction, record, material)
      };
    });
    if (result.kind === "replay") {
      await this.invalidate();
      return null;
    }
    if (result.kind === "issued") {
      await this.ctx.storage.setAlarm(result.value.sessionExpiresAt);
      return result.value;
    }
    return null;
  }

  async validateAccessToken(token: string, resource: string, now: number): Promise<{
    encryptedSessionKey: EncryptedValueV1;
    sessionExpiresAt: number;
    scope: string;
    iiPermission: IiPermission;
  } | null> {
    const tokenHash = await sha256(token);
    const record = await this.getSession();
    if (
      !record ||
      record.phase !== "active" ||
      !record.accessTokenHash ||
      !record.accessTokenExpiresAt ||
      record.accessTokenExpiresAt <= now ||
      !record.sessionExpiresAt ||
      record.sessionExpiresAt <= now ||
      record.resource !== resource ||
      !record.iiPermission ||
      !hashEquals(record.accessTokenHash, tokenHash)
    ) {
      return null;
    }
    return {
      encryptedSessionKey: record.sessionKey,
      sessionExpiresAt: record.sessionExpiresAt,
      scope: record.scope,
      iiPermission: record.iiPermission
    };
  }

  async invalidate(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<AuthStateRecordV3>(RECORD_KEY);
    if (!record) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const deadline = recordDeadline(record);
    if (deadline === null || deadline <= Date.now()) {
      await this.invalidate();
      return;
    }
    await this.ctx.storage.setAlarm(deadline);
  }

  private async getSession(): Promise<AuthorizationSessionRecordV3 | null> {
    const record = await this.ctx.storage.get<AuthStateRecordV3>(RECORD_KEY);
    return record?.kind === "authorization_session" ? record : null;
  }
}

type TokenMaterial = {
  accessToken: string;
  accessTokenHash: string;
  refreshToken: string;
  refreshTokenHash: string;
  now: number;
};

async function createTokenMaterial(sessionId: string | null, issueRefreshToken: boolean, now: number): Promise<TokenMaterial> {
  const routedSessionId = sessionId ?? randomOpaque(18);
  const accessToken = `mka1.${routedSessionId}.${randomOpaque()}`;
  const refreshToken = issueRefreshToken ? `mkr1.${routedSessionId}.${randomOpaque()}` : "";
  return {
    accessToken,
    accessTokenHash: await sha256(accessToken),
    refreshToken,
    refreshTokenHash: refreshToken ? await sha256(refreshToken) : "",
    now
  };
}

async function storeInitialTokens(
  transaction: DurableObjectTransaction,
  record: AuthorizationSessionRecordV3,
  material: TokenMaterial,
  issueRefreshToken: boolean
): Promise<TokenIssueResult> {
  const refreshAllowed = issueRefreshToken && record.scope.split(/\s+/u).includes("offline_access");
  record.consumedCodeHash = record.pendingCodeHash;
  record.pendingCodeHash = null;
  record.authorizationCodeExpiresAt = null;
  record.accessTokenHash = material.accessTokenHash;
  record.accessTokenExpiresAt = Math.min(material.now + ACCESS_TOKEN_TTL_MS, requiredSessionExpiry(record));
  record.currentRefreshTokenHash = refreshAllowed ? material.refreshTokenHash : null;
  record.phase = "active";
  await transaction.put(RECORD_KEY, record);
  return tokenIssueResult(record, material, refreshAllowed);
}

async function storeRotatedTokens(
  transaction: DurableObjectTransaction,
  record: AuthorizationSessionRecordV3,
  material: TokenMaterial
): Promise<TokenIssueResult> {
  record.spentRefreshTokenHashes.push(requiredCurrentRefreshTokenHash(record));
  record.currentRefreshTokenHash = material.refreshTokenHash;
  record.accessTokenHash = material.accessTokenHash;
  record.accessTokenExpiresAt = Math.min(material.now + ACCESS_TOKEN_TTL_MS, requiredSessionExpiry(record));
  await transaction.put(RECORD_KEY, record);
  return tokenIssueResult(record, material, true);
}

function tokenIssueResult(
  record: AuthorizationSessionRecordV3,
  material: TokenMaterial,
  includeRefreshToken: boolean
): TokenIssueResult {
  return {
    accessToken: material.accessToken,
    refreshToken: includeRefreshToken ? material.refreshToken : null,
    accessExpiresAt: record.accessTokenExpiresAt!,
    sessionExpiresAt: requiredSessionExpiry(record),
    scope: record.scope,
    resource: record.resource,
    encryptedSessionKey: record.sessionKey
  };
}

function recordDeadline(record: AuthStateRecordV3): number | null {
  if (record.kind === "oauth_client") {
    return record.clientExpiresAt;
  }
  if (record.phase === "pending" || record.phase === "redeeming") {
    return record.connectExpiresAt;
  }
  if (record.phase === "authorized") {
    return record.authorizationCodeExpiresAt;
  }
  if (record.phase === "active") {
    return record.sessionExpiresAt;
  }
  return null;
}

function requiredSessionExpiry(record: AuthorizationSessionRecordV3): number {
  if (record.sessionExpiresAt === null) {
    throw new Error("session expiration is unavailable");
  }
  return record.sessionExpiresAt;
}

function requiredCurrentRefreshTokenHash(record: AuthorizationSessionRecordV3): string {
  if (!record.currentRefreshTokenHash) {
    throw new Error("refresh token hash is unavailable");
  }
  return record.currentRefreshTokenHash;
}

function routeId(token: string): string | null {
  const parts = token.split(".");
  return parts.length === 3 && /^[A-Za-z0-9_-]+$/u.test(parts[1]) ? parts[1] : null;
}

function hashEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
