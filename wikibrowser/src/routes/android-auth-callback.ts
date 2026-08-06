import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/android-auth-callback/route";

export const Route = createFileRoute("/android-auth-callback")({ server: { handlers: { GET: () => GET() } } });
