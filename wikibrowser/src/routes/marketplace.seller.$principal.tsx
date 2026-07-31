import { createFileRoute } from "@tanstack/react-router";
import SellerProfilePage from "@/app/marketplace/seller/[principal]/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/marketplace/seller/$principal")({
  head: () => routeHead("Kinic Marketplace Seller", "Browse public Kinic Marketplace listings by seller."),
  component: () => <SellerProfilePage principal={Route.useParams().principal} />
});
