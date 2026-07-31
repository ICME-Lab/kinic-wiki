import { createFileRoute } from "@tanstack/react-router";
import HomePage, { metadata } from "@/app/page";

export const Route = createFileRoute("/")({
  head: () => ({ meta: metadataToTags(metadata) }),
  component: HomePage
});

function metadataToTags(value: Record<string, unknown>) {
  return [
    { title: String(value.title ?? "Kinic Wiki") },
    { name: "description", content: String(value.description ?? "") }
  ];
}
