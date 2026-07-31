import { createFileRoute } from "@tanstack/react-router";
import { GET } from "@/app/ios-share/route";

export const Route = createFileRoute("/ios-share")({ server: { handlers: { GET: () => GET() } } });
