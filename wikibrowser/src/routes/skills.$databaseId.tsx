import { createFileRoute } from "@tanstack/react-router";
import SkillRegistryPage from "@/app/skills/[databaseId]/page";
import { AdminRouteShell } from "@/app/admin-route-shell";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/skills/$databaseId")({
  head: () => routeHead("Kinic Wiki Skill Registry", "Inspect skill packages, run evidence, and permissions for a Kinic Wiki database."),
  component: () => <AdminRouteShell><SkillRegistryPage databaseId={Route.useParams().databaseId} /></AdminRouteShell>
});
