import { createFileRoute, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
import { loadPublicNodePageData, publicNodeHead, PublicNodeDocument } from "@/app/p/[publicId]/page";

const loadPublicNodeRequestOrigin = createServerFn({ method: "GET" }).handler(() => getRequestUrl().origin);

export const Route = createFileRoute("/p/$publicId")({
  loader: async ({ params }) => {
    const [data, origin] = await Promise.all([loadPublicNodePageData(params.publicId), loadPublicNodeRequestOrigin()]);
    if (!data.node) throw notFound();
    return { data, origin };
  },
  head: ({ loaderData, params }) => loaderData ? publicNodeHead(params.publicId, loaderData.data, loaderData.origin) : {},
  component: () => <PublicNodeDocument data={Route.useLoaderData().data} />
});
