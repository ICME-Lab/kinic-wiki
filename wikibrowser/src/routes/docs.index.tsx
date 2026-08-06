import { createFileRoute } from "@tanstack/react-router";
import DocsPage from "@/app/docs/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/docs/")({ head: () => routeHead("Kinic Wiki Docs", "Documentation for KinicWiki iOS, Wiki Clipper, CLI, Canister API, and agent skill workflows."), component: DocsPage });
