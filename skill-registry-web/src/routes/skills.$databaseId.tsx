import { createFileRoute } from "@tanstack/react-router";
import SkillRegistryPage from "@/app/skills/[databaseId]/page";

export const Route = createFileRoute("/skills/$databaseId")({
  component: () => <SkillRegistryPage databaseId={Route.useParams().databaseId} />
});
