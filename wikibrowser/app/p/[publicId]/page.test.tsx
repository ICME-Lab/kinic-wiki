import { describe, expect, it } from "vitest";
import { publicNodeHead, type PublicNodePageData } from "@/app/p/[publicId]/page";

const publicId = "00112233445566778899aabbccddeeff";
const data: PublicNodePageData = {
  node: {
    content: "# Public note",
    updatedAt: "1",
    publishedAtMs: "2"
  },
  title: "Public note",
  description: "Public description"
};

describe("publicNodeHead", () => {
  it.each([
    "https://wiki.kinic.xyz",
    "https://kinic-wiki-browser-staging.example.workers.dev"
  ])("uses the request origin for absolute metadata URLs: %s", (origin) => {
    const head = publicNodeHead(publicId, data, origin);

    expect(head.links).toEqual([
      {
        rel: "canonical",
        href: `${origin}/p/${publicId}`
      }
    ]);
    expect(head.meta).toEqual(expect.arrayContaining([
      { property: "og:url", content: `${origin}/p/${publicId}` },
      { property: "og:image", content: `${origin}/opengraph-image.png` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:image", content: `${origin}/twitter-image.png` }
    ]));
  });
});
