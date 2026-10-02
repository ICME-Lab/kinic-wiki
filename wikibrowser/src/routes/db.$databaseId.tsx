import { createFileRoute, Outlet } from "@tanstack/react-router";
import { ClientWikiBrowser } from "@/components/client-wiki-browser";

export const Route = createFileRoute("/db/$databaseId")({
  component: () => <><div className="wiki-seo-region"><Outlet /></div><ClientWikiBrowser /></>
});
