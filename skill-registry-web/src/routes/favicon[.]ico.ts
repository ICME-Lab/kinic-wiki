import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/favicon.ico")({
  server: { handlers: { GET: () => new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } }) } }
});
