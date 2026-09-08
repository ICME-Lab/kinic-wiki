// Where: workers/payment/src/env.ts
// What: Runtime binding and secret types for IAP fulfillment.
// Why: Payment code must keep App Store and canister credentials explicit.

export type AppStoreEnvironment = "Production" | "Sandbox";

export type D1Database = {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
};

export type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
};

export type D1Result<T = unknown> = {
  success: boolean;
  results?: T[];
  meta: { changes?: number };
};

export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type PaymentSecrets = {
  KINIC_IAP_AUTHORITY_IDENTITY_PEM: string;
  APP_STORE_ISSUER_ID: string;
  APP_STORE_KEY_ID: string;
  APP_STORE_PRIVATE_KEY_PEM: string;
};

export type RuntimeEnv = {
  DB: D1Database;
  IAP_GLOBAL_RATE_LIMITER: RateLimitBinding;
  IAP_PRINCIPAL_RATE_LIMITER: RateLimitBinding;
  KINIC_WIKI_CANISTER_ID: string;
  KINIC_WIKI_IC_HOST?: string;
  KINIC_IAP_AUTHORITY_ID: string;
  KINIC_IAP_AUTHORITY_IDENTITY_PEM: string;
  APP_STORE_ALLOWED_ENVIRONMENTS: string;
  APP_STORE_SANDBOX_FULFILLMENT_ENABLED: string;
  APP_STORE_SANDBOX_GRANT_LIMIT: string;
  APP_STORE_BUNDLE_ID: string;
  APP_STORE_ISSUER_ID: string;
  APP_STORE_KEY_ID: string;
  APP_STORE_PRIVATE_KEY_PEM: string;
  APP_STORE_NOTIFICATION_ROOT_SHA256S: string;
  IAP_PRODUCT_CATALOG_JSON: string;
};

export type SandboxFulfillmentPolicy = {
  enabled: boolean;
  grantLimit: number;
};

export function allowedAppStoreEnvironments(env: RuntimeEnv): ReadonlySet<AppStoreEnvironment> {
  const values = env.APP_STORE_ALLOWED_ENVIRONMENTS.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0 || values.some((value) => value !== "Production" && value !== "Sandbox")) {
    throw new Error("APP_STORE_ALLOWED_ENVIRONMENTS must contain only Production or Sandbox");
  }
  const environments = new Set(values as AppStoreEnvironment[]);
  if (environments.size !== values.length) {
    throw new Error("APP_STORE_ALLOWED_ENVIRONMENTS must not contain duplicates");
  }
  return environments;
}

export function sandboxFulfillmentPolicy(env: RuntimeEnv): SandboxFulfillmentPolicy {
  const enabledValue = env.APP_STORE_SANDBOX_FULFILLMENT_ENABLED;
  if (enabledValue !== "true" && enabledValue !== "false") {
    throw new Error("APP_STORE_SANDBOX_FULFILLMENT_ENABLED must be true or false");
  }
  if (!/^[1-9][0-9]*$/u.test(env.APP_STORE_SANDBOX_GRANT_LIMIT)) {
    throw new Error("APP_STORE_SANDBOX_GRANT_LIMIT must be a positive integer");
  }
  const grantLimit = Number(env.APP_STORE_SANDBOX_GRANT_LIMIT);
  if (!Number.isSafeInteger(grantLimit)) {
    throw new Error("APP_STORE_SANDBOX_GRANT_LIMIT exceeds the safe integer range");
  }
  return { enabled: enabledValue === "true", grantLimit };
}
