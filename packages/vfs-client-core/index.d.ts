export type CandidResult<T> = { Ok: T } | { Err: unknown };
export type CandidOptional<T> = [] | [T];

export function unwrapCandidResult<T>(
  result: CandidResult<T>,
  errorFactory?: (message: string) => Error
): T;
export function candidOptional<T>(value: T | null | undefined): CandidOptional<T>;
export function variantName(value: object | null | undefined): string | undefined;
export function isLocalReplicaHost(value: string): boolean;
