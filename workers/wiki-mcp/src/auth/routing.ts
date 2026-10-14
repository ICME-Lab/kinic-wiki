// Routing selects a session; the session still verifies the complete token.
export function sessionName(sessionId: string): string {
  return `session:${sessionId}`;
}

export function parseRoutedToken(token: string, prefix: string): string | null {
  const parts = token.split(".");
  return parts.length === 3 && parts[0] === prefix && /^[A-Za-z0-9_-]+$/u.test(parts[1]) ? parts[1] : null;
}
