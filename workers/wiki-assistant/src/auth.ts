import { DurableObject } from "cloudflare:workers";
import {
  generateIiKey,
  restoreIiKey,
  redeemRegistration,
  mintKinicDelegation,
  restoreKinicIdentity,
  type IiKeyJson,
  type KinicDelegationMaterialV1,
} from "@kinic/ii-server/internet-identity";
import {
  encryptJson,
  decryptJson,
  randomOpaque,
  sha256,
  secretEquals,
  base64UrlEncode,
  type EncryptedValueV1,
} from "@kinic/ii-server/crypto";
import { AssistantError } from "./contracts";
import type { Env } from "./env";

type AuthRecord = {
  id: string;
  tokenHash: string;
  stateHash: string;
  expiresAt: number;
  phase: "pending" | "claiming" | "active";
  registration: EncryptedValueV1 | null;
  key: EncryptedValueV1;
  principal: string | null;
  cached: EncryptedValueV1 | null;
  cachedUntil: number;
};
export type Authorization = {
  authId: string;
  principal: string;
  material: KinicDelegationMaterialV1;
  expiresAt: number;
};
export function requireEnabled(env: Env): void {
  if (env.ASSISTANT_ENABLED !== "true")
    throw new AssistantError("assistant_disabled", 503);
  if (!env.OPENAI_API_KEY || !env.ASSISTANT_KEY_ENCRYPTION_KEY)
    throw new AssistantError("assistant_not_configured", 503);
}
export function invited(env: Env, principal: string): boolean {
  const list: unknown = JSON.parse(env.ASSISTANT_INVITED_PRINCIPALS);
  return (
    Array.isArray(list) && list.includes(principal) && principal !== "2vxsx-fae"
  );
}
export class AssistantAuth extends DurableObject<Env> {
  private minting: Promise<Authorization> | null = null;
  private encryptionKey(): string {
    const key = this.env.ASSISTANT_KEY_ENCRYPTION_KEY;
    if (!key) throw new AssistantError("assistant_not_configured", 503);
    return key;
  }
  async begin(
    id: string,
  ): Promise<{ token: string; state: string; registrationKey: string }> {
    if (await this.ctx.storage.get("auth"))
      throw new AssistantError("auth_already_started");
    const token = randomOpaque();
    const state = randomOpaque();
    const registration = generateIiKey();
    const key = generateIiKey();
    const record: AuthRecord = {
      id,
      tokenHash: await sha256(token),
      stateHash: await sha256(state),
      expiresAt: Date.now() + 600000,
      phase: "pending",
      registration: await encryptJson(
        registration.toJSON(),
        this.encryptionKey(),
        id + ":registration",
      ),
      key: await encryptJson(key.toJSON(), this.encryptionKey(), id + ":key"),
      principal: null,
      cached: null,
      cachedUntil: 0,
    };
    await this.ctx.storage.put("auth", record);
    await this.ctx.storage.setAlarm(record.expiresAt);
    return {
      token,
      state,
      registrationKey: base64UrlEncode(
        new Uint8Array(registration.getPublicKey().toDer()),
      ),
    };
  }
  private async record(token?: string): Promise<AuthRecord> {
    const record = await this.ctx.storage.get<AuthRecord>("auth");
    if (
      !record ||
      record.expiresAt <= Date.now() ||
      (token !== undefined && !(await secretEquals(record.tokenHash, token)))
    )
      throw new AssistantError("authentication_required", 401);
    return record;
  }
  async complete(
    token: string,
    state: string,
    delegation: string,
  ): Promise<Authorization> {
    const record = await this.record(token);
    if (
      record.phase !== "pending" ||
      !record.registration ||
      !(await secretEquals(record.stateHash, state))
    )
      throw new AssistantError("invalid_auth_state", 403);
    // Claim before external I/O. A failed exchange must be restarted, never replayed.
    const claimed = await this.ctx.storage.transaction(async (tx) => {
      const current = await tx.get<AuthRecord>("auth");
      if (!current || current.phase !== "pending") return false;
      current.phase = "claiming";
      await tx.put("auth", current);
      return true;
    });
    if (!claimed) throw new AssistantError("invalid_auth_state", 403);
    const registration = restoreIiKey(
      await decryptJson<IiKeyJson>(
        record.registration,
        this.encryptionKey(),
        record.id + ":registration",
      ),
    );
    const key = restoreIiKey(
      await decryptJson<IiKeyJson>(
        record.key,
        this.encryptionKey(),
        record.id + ":key",
      ),
    );
    const grant = await redeemRegistration(registration, key, delegation);
    if (grant.permissions !== "queries")
      throw new AssistantError("choose_questions_only", 403);
    const minted = await mintKinicDelegation(
      key,
      this.env.ASSISTANT_DERIVATION_ORIGIN,
    );
    const principal = minted.identity.getPrincipal().toText();
    if (!invited(this.env, principal))
      throw new AssistantError("invitation_required", 403);
    record.phase = "active";
    record.registration = null;
    record.stateHash = "";
    record.principal = principal;
    record.expiresAt = Math.min(grant.grantExpiresAt, Date.now() + 3600000);
    record.cached = await encryptJson(
      minted.material,
      this.encryptionKey(),
      record.id + ":delegation",
    );
    record.cachedUntil = minted.material.expiresAt;
    const current = await this.ctx.storage.get<AuthRecord>("auth");
    if (!current || current.phase !== "claiming")
      throw new AssistantError("authentication_required", 401);
    await this.ctx.storage.put("auth", record);
    await this.ctx.storage.setAlarm(record.expiresAt);
    return {
      authId: record.id,
      principal,
      material: minted.material,
      expiresAt: record.expiresAt,
    };
  }
  async authorize(token: string): Promise<Authorization> {
    await this.record(token);
    return this.material();
  }
  async ownerForCleanup(
    token: string,
  ): Promise<{ authId: string; principal: string } | null> {
    const record = await this.ctx.storage.get<AuthRecord>("auth");
    if (!record?.principal || !(await secretEquals(record.tokenHash, token)))
      return null;
    return { authId: record.id, principal: record.principal };
  }
  async material(): Promise<Authorization> {
    requireEnabled(this.env);
    if (this.minting) return this.minting;
    this.minting = this.loadMaterial();
    try {
      return await this.minting;
    } finally {
      this.minting = null;
    }
  }
  private async loadMaterial(): Promise<Authorization> {
    const record = await this.record();
    if (
      record.phase !== "active" ||
      !record.principal ||
      !invited(this.env, record.principal)
    )
      throw new AssistantError("authentication_required", 401);
    let material: KinicDelegationMaterialV1;
    if (record.cached && record.cachedUntil > Date.now() + 30000) {
      material = await decryptJson<KinicDelegationMaterialV1>(
        record.cached,
        this.encryptionKey(),
        record.id + ":delegation",
      );
      restoreKinicIdentity(
        material,
        this.env.ASSISTANT_DERIVATION_ORIGIN,
        Date.now(),
      );
    } else {
      const key = restoreIiKey(
        await decryptJson<IiKeyJson>(
          record.key,
          this.encryptionKey(),
          record.id + ":key",
        ),
      );
      const minted = await mintKinicDelegation(
        key,
        this.env.ASSISTANT_DERIVATION_ORIGIN,
      );
      if (minted.identity.getPrincipal().toText() !== record.principal)
        throw new AssistantError("identity_changed", 401);
      material = minted.material;
      record.cached = await encryptJson(
        material,
        this.encryptionKey(),
        record.id + ":delegation",
      );
      record.cachedUntil = material.expiresAt;
      if (!(await this.ctx.storage.get("auth")))
        throw new AssistantError("authentication_required", 401);
      await this.ctx.storage.put("auth", record);
    }
    return {
      authId: record.id,
      principal: record.principal,
      material,
      expiresAt: record.expiresAt,
    };
  }
  async revoke(token: string): Promise<void> {
    await this.record(token);
    await this.ctx.storage.deleteAll();
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
