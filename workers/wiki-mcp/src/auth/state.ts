import { DurableObject } from "cloudflare:workers";
import type { RuntimeEnv } from "../vfs.js";
import { decryptJson, encryptJson, randomOpaque, sha256, type EncryptedValueV1 } from "./crypto.js";
import {
  IiDelegationError,
  IiSessionEndedError,
  mintKinicDelegation,
  resolveKinicMcpTargetOrigin,
  restoreIiKey,
  restoreKinicIdentity,
  type IiDelegationStage,
  type IiKeyJson,
  type IiPermission,
  type KinicDelegationMaterialV1
} from "./internet-identity.js";

const RECORD_KEY = "record";
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_CLIENT_IDLE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SPENT_REFRESH_TOKENS = 64;
export const DELEGATION_REFRESH_MARGIN_MS = 30_000;

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

export type IdentitySource = "internet_identity" | "review_service";
export type ActionPermission = IiPermission;

export type AuthorizationSessionRecordV5 = {
  version: 5;
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
  registrationPublicKey: string;
  registrationKey: EncryptedValueV1 | null;
  sessionKey: EncryptedValueV1 | null;
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
  identitySource: IdentitySource | null;
  actionPermission: ActionPermission | null;
  reviewAccessVersion: string | null;
  cachedDelegation: EncryptedValueV1 | null;
  cachedDelegationTargetOrigin: string | null;
  cachedDelegationExpiresAt: number | null;
};

export type AuthStateRecordV5 = OAuthClientRecordV2 | AuthorizationSessionRecordV5;

function sessionAccessVersionIsCurrent(
  record: AuthorizationSessionRecordV5,
  configuredReviewAccessVersion: string | undefined
): boolean {
  if (record.identitySource === "internet_identity") return true;
  return (
    record.identitySource === "review_service" &&
    record.reviewAccessVersion === configuredReviewAccessVersion?.trim()
  );
}

export type AuthorizationSessionInput = Omit<
  AuthorizationSessionRecordV5,
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
  | "identitySource"
  | "actionPermission"
  | "reviewAccessVersion"
  | "cachedDelegation"
  | "cachedDelegationTargetOrigin"
  | "cachedDelegationExpiresAt"
>;

export type TokenIssueResult = {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: number;
  sessionExpiresAt: number;
  scope: string;
  resource: string;
};

type TokenOperationResult =
  | { kind: "issued"; value: TokenIssueResult }
  | { kind: "invalid" }
  | { kind: "replay" };

export type AccessTokenAuthentication =
  | { kind: "invalid" }
  | {
      kind: "valid";
      scope: string;
      actionPermission: ActionPermission;
      identitySource: IdentitySource;
      delegation: null;
    }
  | {
      kind: "valid";
      scope: string;
      actionPermission: ActionPermission;
      identitySource: "internet_identity";
      delegation: KinicDelegationMaterialV1;
    }
  | { kind: "temporarily_unavailable"; stage: IiDelegationStage | "delegation_cache" };

export class McpAuthStateV5 extends DurableObject<RuntimeEnv> {
  private readonly delegationMint = new SingleFlight<AccessTokenAuthentication>();

  async createClient(record: OAuthClientRecordV2): Promise<boolean> {
    const existing = await this.ctx.storage.get<AuthStateRecordV5>(RECORD_KEY);
    if (existing) {
      return false;
    }
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.setAlarm(record.clientExpiresAt);
    return true;
  }

  async getClient(now: number): Promise<OAuthClientRecordV2 | null> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV5>(RECORD_KEY);
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
    const existing = await this.ctx.storage.get<AuthStateRecordV5>(RECORD_KEY);
    if (existing) {
      return false;
    }
    const record: AuthorizationSessionRecordV5 = {
      ...input,
      version: 5,
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
      identitySource: null,
      actionPermission: null,
      reviewAccessVersion: null,
      cachedDelegation: null,
      cachedDelegationTargetOrigin: null,
      cachedDelegationExpiresAt: null
    };
    await this.ctx.storage.put(RECORD_KEY, record);
    await this.ctx.storage.setAlarm(record.connectExpiresAt);
    return true;
  }

  async claimConnect(connectState: string, cookie: string, now: number): Promise<AuthorizationSessionRecordV5 | null> {
    const connectStateHash = await sha256(connectState);
    const cookieHash = await sha256(cookie);
    const consumedHash = await sha256(randomOpaque());
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV5>(RECORD_KEY);
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

  async inspectPendingConnect(
    connectState: string,
    cookie: string,
    now: number
  ): Promise<{ sessionId: string; registrationPublicKey: string } | null> {
    const connectStateHash = await sha256(connectState);
    const cookieHash = await sha256(cookie);
    const record = await this.ctx.storage.get<AuthStateRecordV5>(RECORD_KEY);
    if (
      record?.kind !== "authorization_session" ||
      record.phase !== "pending" ||
      record.connectExpiresAt <= now ||
      !hashEquals(record.connectStateHash, connectStateHash) ||
      !hashEquals(record.cookieHash, cookieHash)
    ) {
      return null;
    }
    return { sessionId: record.sessionId, registrationPublicKey: record.registrationPublicKey };
  }

  async completeConnect(
    grantExpiresAt: number,
    actionPermission: ActionPermission,
    now: number,
    expectedSessionId: string
  ): Promise<{ code: string; redirectUri: string; oauthState: string } | null> {
    return this.completeAuthorization({
      grantExpiresAt,
      actionPermission,
      identitySource: "internet_identity",
      reviewAccessVersion: null,
      now,
      expectedSessionId
    });
  }

  async completeReviewConnect(
    reviewAccessVersion: string,
    now: number,
    expectedSessionId: string
  ): Promise<{ code: string; redirectUri: string; oauthState: string } | null> {
    return this.completeAuthorization({
      grantExpiresAt: Number.MAX_SAFE_INTEGER,
      actionPermission: "all",
      identitySource: "review_service",
      reviewAccessVersion,
      now,
      expectedSessionId
    });
  }

  private async completeAuthorization(input: {
    grantExpiresAt: number;
    actionPermission: ActionPermission;
    identitySource: IdentitySource;
    reviewAccessVersion: string | null;
    now: number;
    expectedSessionId: string;
  }): Promise<{ code: string; redirectUri: string; oauthState: string } | null> {
    const { grantExpiresAt, actionPermission, identitySource, reviewAccessVersion, now, expectedSessionId } = input;
    const code = `mkc1.${expectedSessionId}.${randomOpaque()}`;
    const pendingCodeHash = await sha256(code);
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<AuthStateRecordV5>(RECORD_KEY);
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
      if (identitySource === "review_service") {
        record.sessionKey = null;
      }
      record.authorizationCodeExpiresAt = Math.min(now + AUTHORIZATION_CODE_TTL_MS, sessionExpiresAt);
      record.sessionExpiresAt = sessionExpiresAt;
      record.identitySource = identitySource;
      record.actionPermission = actionPermission;
      record.reviewAccessVersion = reviewAccessVersion;
      if (actionPermission === "queries") {
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
      const record = await transaction.get<AuthStateRecordV5>(RECORD_KEY);
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
        !sessionAccessVersionIsCurrent(record, this.env.MCP_REVIEW_ACCESS_VERSION) ||
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
      const record = await transaction.get<AuthStateRecordV5>(RECORD_KEY);
      if (
        record?.kind !== "authorization_session" ||
        record.phase !== "active" ||
        !record.sessionExpiresAt ||
        record.sessionExpiresAt <= input.now ||
        !sessionAccessVersionIsCurrent(record, this.env.MCP_REVIEW_ACCESS_VERSION) ||
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
    sessionExpiresAt: number;
    scope: string;
    actionPermission: ActionPermission;
    identitySource: IdentitySource;
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
      !record.actionPermission ||
      !record.identitySource ||
      !sessionAccessVersionIsCurrent(record, this.env.MCP_REVIEW_ACCESS_VERSION) ||
      !hashEquals(record.accessTokenHash, tokenHash)
    ) {
      return null;
    }
    return {
      sessionExpiresAt: record.sessionExpiresAt,
      scope: record.scope,
      actionPermission: record.actionPermission,
      identitySource: record.identitySource
    };
  }

  async authenticateAccessToken(
    token: string,
    resource: string,
    now: number,
    requireDelegation: boolean
  ): Promise<AccessTokenAuthentication> {
    const validated = await this.validateAccessToken(token, resource, now);
    if (!validated) {
      return { kind: "invalid" };
    }
    if (!requireDelegation || validated.identitySource === "review_service") {
      return {
        kind: "valid",
        scope: validated.scope,
        actionPermission: validated.actionPermission,
        identitySource: validated.identitySource,
        delegation: null
      };
    }
    const authorization = {
      scope: validated.scope,
      actionPermission: validated.actionPermission,
      identitySource: "internet_identity" as const
    };

    const targetOrigin = resolveKinicMcpTargetOrigin(
      this.env.KINIC_WIKI_MCP_TARGET_ORIGIN,
      this.env.KINIC_WIKI_CANISTER_ID
    );
    const cached = await this.readCachedDelegation(targetOrigin, now);
    if (cached) {
      logDelegationCache("hit");
      return { kind: "valid", ...authorization, delegation: cached };
    }
    logDelegationCache("miss");
    return this.delegationMint.run(() => this.mintAndCacheDelegation(targetOrigin, authorization, now));
  }

  async invalidate(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<AuthStateRecordV5>(RECORD_KEY);
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

  private async getSession(): Promise<AuthorizationSessionRecordV5 | null> {
    const record = await this.ctx.storage.get<AuthStateRecordV5>(RECORD_KEY);
    return record?.kind === "authorization_session" ? record : null;
  }

  private async readCachedDelegation(
    targetOrigin: string,
    now: number
  ): Promise<KinicDelegationMaterialV1 | null> {
    const record = await this.getSession();
    if (!record?.cachedDelegation || delegationNeedsRefresh(record, targetOrigin, now)) {
      if (record?.cachedDelegation) await this.clearCachedDelegation(record);
      return null;
    }
    try {
      const material = await decryptJson<KinicDelegationMaterialV1>(
        record.cachedDelegation,
        requiredEncryptionKey(this.env),
        delegationContext(record.sessionId, targetOrigin)
      );
      restoreKinicIdentity(material, targetOrigin, now + DELEGATION_REFRESH_MARGIN_MS);
      return material;
    } catch {
      await this.clearCachedDelegation(record);
      return null;
    }
  }

  private async mintAndCacheDelegation(
    targetOrigin: string,
    authorization: {
      scope: string;
      actionPermission: ActionPermission;
      identitySource: "internet_identity";
    },
    now: number
  ): Promise<AccessTokenAuthentication> {
    const record = await this.getSession();
    if (!record || record.phase !== "active" || !record.sessionExpiresAt || record.sessionExpiresAt <= now) {
      return { kind: "invalid" };
    }
    let sessionKey: IiKeyJson;
    try {
      if (!record.sessionKey || record.identitySource !== "internet_identity") {
        throw new Error("Internet Identity session key is unavailable");
      }
      sessionKey = await decryptJson<IiKeyJson>(
        record.sessionKey,
        requiredEncryptionKey(this.env),
        sessionKeyContext(record.sessionId)
      );
    } catch {
      await this.invalidate();
      return { kind: "invalid" };
    }
    try {
      const minted = await mintKinicDelegation(restoreIiKey(sessionKey), targetOrigin);
      const encrypted = await encryptJson(
        minted.material,
        requiredEncryptionKey(this.env),
        delegationContext(record.sessionId, targetOrigin)
      );
      const current = await this.getSession();
      if (
        !current ||
        current.phase !== "active" ||
        current.sessionId !== record.sessionId ||
        !current.sessionExpiresAt ||
        current.sessionExpiresAt <= Date.now()
      ) {
        return { kind: "invalid" };
      }
      current.cachedDelegation = encrypted;
      current.cachedDelegationTargetOrigin = targetOrigin;
      current.cachedDelegationExpiresAt = minted.material.expiresAt;
      await this.ctx.storage.put(RECORD_KEY, current);
      logDelegationCache("stored");
      return { kind: "valid", ...authorization, delegation: minted.material };
    } catch (error) {
      if (error instanceof IiSessionEndedError) {
        await this.invalidate();
        return { kind: "invalid" };
      }
      return {
        kind: "temporarily_unavailable",
        stage: error instanceof IiDelegationError ? error.stage : "delegation_cache"
      };
    }
  }

  private async clearCachedDelegation(record: AuthorizationSessionRecordV5): Promise<void> {
    const current = await this.getSession();
    if (
      !current ||
      current.sessionId !== record.sessionId ||
      !sameEncryptedValue(current.cachedDelegation, record.cachedDelegation) ||
      current.cachedDelegationTargetOrigin !== record.cachedDelegationTargetOrigin ||
      current.cachedDelegationExpiresAt !== record.cachedDelegationExpiresAt
    ) {
      return;
    }
    current.cachedDelegation = null;
    current.cachedDelegationTargetOrigin = null;
    current.cachedDelegationExpiresAt = null;
    await this.ctx.storage.put(RECORD_KEY, current);
  }
}

function sameEncryptedValue(left: EncryptedValueV1 | null, right: EncryptedValueV1 | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.version === right.version &&
      left.algorithm === right.algorithm &&
      left.iv === right.iv &&
      left.ciphertext === right.ciphertext)
  );
}

export function delegationNeedsRefresh(
  record: Pick<AuthorizationSessionRecordV5, "cachedDelegationTargetOrigin" | "cachedDelegationExpiresAt">,
  targetOrigin: string,
  now: number
): boolean {
  return (
    record.cachedDelegationTargetOrigin !== targetOrigin ||
    !record.cachedDelegationExpiresAt ||
    record.cachedDelegationExpiresAt <= now + DELEGATION_REFRESH_MARGIN_MS
  );
}

export class SingleFlight<T> {
  private running: Promise<T> | null = null;

  run(factory: () => Promise<T>): Promise<T> {
    if (this.running) return this.running;
    const running = factory();
    this.running = running;
    void running.finally(() => {
      if (this.running === running) this.running = null;
    }).catch(() => undefined);
    return running;
  }
}

export function sessionKeyContext(sessionId: string): string {
  return `session:${sessionId}:session-key:v1`;
}

export function delegationContext(sessionId: string, targetOrigin: string): string {
  return `session:${sessionId}:delegation:${targetOrigin}:v1`;
}

function requiredEncryptionKey(env: RuntimeEnv): string {
  const key = env.MCP_KEY_ENCRYPTION_KEY?.trim();
  if (!key) throw new Error("MCP_KEY_ENCRYPTION_KEY is required");
  return key;
}

function logDelegationCache(outcome: "hit" | "miss" | "stored"): void {
  console.log(JSON.stringify({ event: "mcp_delegation_cache", outcome }));
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
  record: AuthorizationSessionRecordV5,
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
  record: AuthorizationSessionRecordV5,
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
  record: AuthorizationSessionRecordV5,
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
  };
}

function recordDeadline(record: AuthStateRecordV5): number | null {
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

function requiredSessionExpiry(record: AuthorizationSessionRecordV5): number {
  if (record.sessionExpiresAt === null) {
    throw new Error("session expiration is unavailable");
  }
  return record.sessionExpiresAt;
}

function requiredCurrentRefreshTokenHash(record: AuthorizationSessionRecordV5): string {
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
