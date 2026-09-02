import { createFileRoute } from "@tanstack/react-router";
import SkillsDocsPage from "@/app/docs/skills/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/docs/skills/")({
  head: () => routeHead("Kinic Wiki Skills Docs", "Agent workflow skills for querying, editing, ingesting, linting, exporting, and managing Skill Registry packages."),
  component: SkillsDocsPage
});
