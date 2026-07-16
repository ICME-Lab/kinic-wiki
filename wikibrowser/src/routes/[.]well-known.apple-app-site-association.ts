import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/.well-known/apple-app-site-association/route";

export const Route = createFileRoute("/.well-known/apple-app-site-association")({ server: { handlers: { GET: () => GET() } } });
