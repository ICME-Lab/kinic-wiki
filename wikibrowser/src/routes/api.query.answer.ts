import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { OPTIONS, POST } from "@/app/api/query/answer/route";

export const Route = createFileRoute("/api/query/answer")({
  server: { handlers: { OPTIONS: ({ request }) => OPTIONS(request), POST: ({ request }) => POST(request, env) } }
});
