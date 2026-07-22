import { createFileRoute } from "@tanstack/react-router";
import robots from "@/app/robots";

export const Route = createFileRoute("/robots.txt")({ server: { handlers: { GET: () => {
  const config = robots();
  const body = `User-agent: ${config.rules.userAgent}\nAllow: ${config.rules.allow}\n${config.rules.disallow.map((path) => `Disallow: ${path}`).join("\n")}\nSitemap: ${config.sitemap}\n`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
} } } });
