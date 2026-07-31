import { createFileRoute } from "@tanstack/react-router";
import SkillDocPage from "@/app/docs/skills/[slug]/page";
import { findSkillDoc } from "@/app/docs/docs-data";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/docs/skills/$slug")({
  head: ({ params }) => {
    const doc = findSkillDoc(params.slug);
    return doc
      ? routeHead(`Kinic Wiki ${doc.title} Skill`, doc.description)
      : routeHead("Kinic Wiki Skill Docs", "Kinic Wiki agent workflow skill documentation.");
  },
  component: () => <SkillDocPage slug={Route.useParams().slug} />
});
