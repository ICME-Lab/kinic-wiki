export function authRequestKey(principal: string | null): string {
  return principal ? `auth:${principal}` : "anonymous";
}

export function nodeRequestKey(canisterId: string, databaseId: string, path: string, principal: string | null = null): string {
  return `${canisterId}\n${databaseId}\n${path}\n${authRequestKey(principal)}`;
}

export function graphRequestKey(
  canisterId: string,
  databaseId: string,
  centerPath: string | null,
  depth: 1 | 2,
  principal: string | null = null
): string | null {
  if (centerPath === null) return null;
  return `${canisterId}\n${databaseId}\n${centerPath}\n${depth}\n${authRequestKey(principal)}`;
}

export function searchRequestKey(canisterId: string, databaseId: string, searchKind: string, searchText: string, principal: string | null = null): string {
  return `${canisterId}\n${databaseId}\n${searchKind}\n${searchText}\n${authRequestKey(principal)}`;
}
