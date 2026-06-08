// Where: wikibrowser/lib/marketplace-routes.ts
// What: builds marketplace detail routes from public canister listing IDs.
// Why: marketplace listing IDs are canonical across canister APIs and URLs.

export function marketListingPath(listingId: string): string {
  return `/marketplace/${listingId}`;
}
