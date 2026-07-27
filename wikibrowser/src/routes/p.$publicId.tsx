import { createFileRoute, notFound } from "@tanstack/react-router";
import { loadPublicNodePageData, publicNodeHead, PublicNodeDocument } from "@/app/p/[publicId]/page";

export const Route = createFileRoute("/p/$publicId")({
  loader: async ({ params }) => {
    const data = await loadPublicNodePageData(params.publicId);
    if (!data.node) throw notFound();
    return data;
  },
  head: ({ loaderData, params }) => loaderData ? publicNodeHead(params.publicId, loaderData) : {},
  component: () => <PublicNodeDocument data={Route.useLoaderData()} />
});
