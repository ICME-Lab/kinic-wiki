import { createFileRoute } from "@tanstack/react-router";
import ListingDetailPage from "@/app/marketplace/[listingId]/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/marketplace/$listingId")({
  head: () => routeHead("Kinic Marketplace Listing", "View a Kinic Marketplace database access listing."),
  component: () => <ListingDetailPage listingId={Route.useParams().listingId} />
});
