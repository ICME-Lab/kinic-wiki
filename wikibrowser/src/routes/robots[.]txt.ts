import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import robots from "@/app/robots";

export const Route = createFileRoute("/robots.txt")({ server: { handlers: { GET: () => {
  if (env.KINIC_DEPLOYMENT_ENV === "staging") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
  const config = robots();
  const body = `User-agent: ${config.rules.userAgent}\nAllow: ${config.rules.allow}\n${config.rules.disallow.map((path) => `Disallow: ${path}`).join("\n")}\nSitemap: ${config.sitemap}\n`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
} } } });
