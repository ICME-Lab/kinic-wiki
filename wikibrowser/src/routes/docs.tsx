import { createFileRoute, Outlet } from "@tanstack/react-router";
import DocsLayout from "@/app/docs/layout";

export const Route = createFileRoute("/docs")({ component: () => <DocsLayout><Outlet /></DocsLayout> });
