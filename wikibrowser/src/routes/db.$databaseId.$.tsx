import { createFileRoute } from "@tanstack/react-router";
import { loadWikiDatabasePageData, wikiDatabaseHead, WikiDatabaseDocument } from "@/app/db/[databaseId]/[[...segments]]/page";

export const Route = createFileRoute("/db/$databaseId/$")({
  loader: ({ params }) => loadWikiDatabasePageData(params.databaseId, params._splat?.split("/").filter(Boolean)),
  head: ({ loaderData }) => loaderData ? wikiDatabaseHead(loaderData) : {},
  component: () => <WikiDatabaseDocument data={Route.useLoaderData()} />
});
