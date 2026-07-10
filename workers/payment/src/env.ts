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
  KINIC_IAP_AUTHORITY_IDENTITY_PEM: string;
  APP_STORE_ENVIRONMENT: AppStoreEnvironment;
  APP_STORE_BUNDLE_ID: string;
  APP_STORE_ISSUER_ID: string;
  APP_STORE_KEY_ID: string;
  APP_STORE_PRIVATE_KEY_PEM: string;
  APP_STORE_NOTIFICATION_ROOT_SHA256?: string;
  IAP_PRODUCT_CATALOG_JSON: string;
};
