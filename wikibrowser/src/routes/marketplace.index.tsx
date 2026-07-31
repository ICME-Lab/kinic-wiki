import { createFileRoute } from "@tanstack/react-router";
import MarketplacePage from "@/app/marketplace/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/marketplace/")({ head: () => routeHead("Kinic Marketplace", "Browse paid Kinic Wiki database access listings."), component: MarketplacePage });
