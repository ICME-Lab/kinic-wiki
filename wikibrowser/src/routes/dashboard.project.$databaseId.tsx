import { createFileRoute } from "@tanstack/react-router";
import DashboardDatabasePage from "@/app/dashboard/project/[databaseId]/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/dashboard/project/$databaseId")({
  head: () => routeHead("Kinic Wiki Database Settings", "Manage database metadata, access, billing, and marketplace settings."),
  component: () => <DashboardDatabasePage databaseId={Route.useParams().databaseId} />
});
