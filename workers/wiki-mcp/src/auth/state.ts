import { DurableObject } from "cloudflare:workers";
import type { RuntimeEnv } from "../vfs.js";
import type { EncryptedValueV1 } from "./crypto.js";
import { randomOpaque, sha256 } from "./crypto.js";

const RECORD_KEY = "record";
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

export type ClientAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export type OAuthClientRecordV1 = {
  version: 1;
  kind: "oauth_client";
  clientId: string;
  redirectUris: string[];
  grantTypes: Array<"authorization_code" | "refresh_token">;
  tokenEndpointAuthMethod: ClientAuthMethod;
  clientSecretHash: string | null;
  createdAt: number;
};

export type PendingSessionRecordV1 = {
  version: 1;
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
  codeHash: string | null;
  accessTokenHash: string | null;
  accessExpiresAt: number | null;
  refreshTokenHash: string | null;
  createdAt: number;
  sessionCapAt: number;
  expiresAt: number;
  grantExpiresAt: number | null;
};

export type AuthStateRecordV1 = OAuthClientRecordV1 | PendingSessionRecordV1;

export type PendingSessionInput = Omit<PendingSessionRecordV1, "version" | "kind" | "phase" | "codeHash" | "accessTokenHash" | "accessExpiresAt" | "refreshTokenHash" | "grantExpiresAt">;

export type TokenIssueResult = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number;
  sessionExpiresAt: number;
  scope: string;
  resource: string;
  encryptedSessionKey: EncryptedValueV1;
};

export class McpAuthState extends DurableObject<RuntimeEnv> {
  async createClient(record: OAuthClientRecordV1): Promise<boolean> {
    const existing = await this.ctx.storage.get<AuthStateRecordV1>(RECORD_KEY);
    if (existing) {
      return false;
    }
    await this.ctx.storage.put(RECORD_KEY, record);
    return true;
  }

  async getClient(): Promise<OAuthClientRecordV1 | null> {
    const record = await this.ctx.storage.get<AuthStateRecordV1>(RECORD_KEY);
    return record?.kind === "oauth_client" ? record : null;
  }

  async createSession(input: PendingSessionInput): Promise<boolean> {
    const existing = await this.ctx.storage.get<AuthStateRecordV1>(RECORD_KEY);
    if (existing) {
      return false;
    }
    const record: PendingSessionRecordV1 = {
      ...input,
      version: 1,
      kind: "authorization_session",
      phase: "pending",
      codeHash: null,
      accessTokenHash: null,
      accessExpiresAt: null,
      refreshTokenHash: null,
      grantExpiresAt: null
    };
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.setAlarm(record.expiresAt);
    return true;
  }

  async claimConnect(connectState: string, cookie: string, now: number): Promise<PendingSessionRecordV1 | null> {
    const connectStateHash = await sha256(connectState);
    const cookieHash = await sha256(cookie);
    const consumedHash = await sha256(randomOpaque());
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV1>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "pending" ||
        record.expiresAt <= now ||
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
    now: number,
    expectedSessionId: string
  ): Promise<{ code: string; redirectUri: string; oauthState: string } | null> {
    const code = `mkc1.${expectedSessionId}.${randomOpaque()}`;
    const codeHash = await sha256(code);
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV1>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "redeeming" ||
        record.expiresAt <= now ||
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
      record.codeHash = codeHash;
      record.registrationKey = null;
      record.grantExpiresAt = grantExpiresAt;
      record.expiresAt = sessionExpiresAt;
      record.phase = "authorized";
      await transaction.put(RECORD_KEY, record);
      return { code, redirectUri: record.redirectUri, oauthState: record.oauthState, expiresAt: record.expiresAt };
    });
    if (result) {
      await this.ctx.storage.setAlarm(result.expiresAt);
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
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV1>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "authorized" ||
        !record.codeHash ||
        record.expiresAt <= input.now ||
        record.clientId !== input.clientId ||
        record.redirectUri !== input.redirectUri ||
        !hashEquals(record.codeHash, codeHash) ||
        !hashEquals(record.codeChallenge, verifierChallenge)
      ) {
        return null;
      }
      return storeIssuedTokens(transaction, record, material, input.issueRefreshToken);
    });
  }

  async rotateRefreshToken(input: { refreshToken: string; clientId: string; resource: string; now: number }): Promise<TokenIssueResult | null> {
    const refreshTokenHash = await sha256(input.refreshToken);
    const material = await createTokenMaterial(routeId(input.refreshToken), true, input.now);
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV1>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "active" ||
        !record.refreshTokenHash ||
        record.expiresAt <= input.now ||
        record.clientId !== input.clientId ||
        record.resource !== input.resource ||
        !hashEquals(record.refreshTokenHash, refreshTokenHash)
      ) {
        return null;
      }
      return storeIssuedTokens(transaction, record, material, true);
    });
  }

  async validateAccessToken(token: string, resource: string, now: number): Promise<{
    encryptedSessionKey: EncryptedValueV1;
    sessionExpiresAt: number;
  } | null> {
    const tokenHash = await sha256(token);
    const record = await this.getSession();
    if (
      !record ||
      record.phase !== "active" ||
      !record.accessTokenHash ||
      !record.accessExpiresAt ||
      record.accessExpiresAt <= now ||
      record.expiresAt <= now ||
      record.resource !== resource ||
      !hashEquals(record.accessTokenHash, tokenHash)
    ) {
      return null;
    }
    return { encryptedSessionKey: record.sessionKey, sessionExpiresAt: record.expiresAt };
  }

  async invalidate(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<AuthStateRecordV1>(RECORD_KEY);
    if (record?.kind === "authorization_session" && record.expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
    }
  }

  private async getSession(): Promise<PendingSessionRecordV1 | null> {
    const record = await this.ctx.storage.get<AuthStateRecordV1>(RECORD_KEY);
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

async function storeIssuedTokens(
  transaction: DurableObjectTransaction,
  record: PendingSessionRecordV1,
  material: TokenMaterial,
  issueRefreshToken: boolean
): Promise<TokenIssueResult> {
  const refreshAllowed = issueRefreshToken && record.scope.split(/\s+/u).includes("offline_access");
  const accessExpiresAt = Math.min(material.now + ACCESS_TOKEN_TTL_MS, record.expiresAt);
  record.codeHash = null;
  record.accessTokenHash = material.accessTokenHash;
  record.accessExpiresAt = accessExpiresAt;
  record.refreshTokenHash = refreshAllowed ? material.refreshTokenHash : null;
  record.phase = "active";
  await transaction.put(RECORD_KEY, record);
  return {
    accessToken: material.accessToken,
    refreshToken: refreshAllowed ? material.refreshToken : null,
    accessExpiresAt,
    sessionExpiresAt: record.expiresAt,
    scope: record.scope,
    resource: record.resource,
    encryptedSessionKey: record.sessionKey
  };
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
