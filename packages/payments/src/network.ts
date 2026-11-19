export function configuredLoopback(host: string): boolean {
  const name = new URL(host).hostname;
  return name === "0.0.0.0" || name === "localhost" || name.endsWith(".localhost") || name === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(name);
}
