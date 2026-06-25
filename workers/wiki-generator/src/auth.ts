// Where: workers/wiki-generator/src/auth.ts
// What: Bearer token validation for manual worker triggers.
// Why: Manual generation can spend tokens and write knowledge pages.
export async function isAuthorized(request: Request, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(header, `Bearer ${token}`);
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) {
    await crypto.subtle.digest("SHA-256", leftBytes);
    return false;
  }
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}
