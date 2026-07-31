import { createFileRoute, Outlet } from "@tanstack/react-router";
import MarketplaceLayout from "@/app/marketplace/layout";

export const Route = createFileRoute("/marketplace")({ component: () => <MarketplaceLayout><Outlet /></MarketplaceLayout> });
