// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PublicNodeDocument,
  publicNodeDescription,
  publicNodeHead,
  publicNodeTitle,
  type PublicNodePageData
} from "@/app/p/[publicId]/page";

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

const originalScrollTo = window.scrollTo;

beforeAll(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => cleanup());

afterAll(() => {
  window.scrollTo = originalScrollTo;
});

describe("PublicNodeDocument", () => {
  it("renders accessible brand, publication, content, and dashboard links", async () => {
    const rootRoute = createRootRoute({ component: Outlet });
    const pageRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <PublicNodeDocument data={data} />
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: rootRoute.addChildren([pageRoute])
    });

    render(<RouterProvider router={router} />);

    const homeLink = await screen.findByRole("link", { name: "Kinic Wiki home" });
    expect(homeLink.getAttribute("href")).toBe("/");
    expect(homeLink.querySelector('img[src="/kinic-mark.png"]')).not.toBeNull();
    expect(screen.getByText("Published with Kinic Wiki")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Public note" })).not.toBeNull();

    const dashboardLinks = screen.getAllByRole("link", { name: "Start using Kinic Wiki" });
    expect(dashboardLinks).toHaveLength(2);
    for (const dashboardLink of dashboardLinks) {
      expect(dashboardLink.getAttribute("href")).toBe("/dashboard");
    }
  });
});

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

describe("publicNodeTitle", () => {
  it.each([
    ["Public note\n===========", "Public note"],
    ["Public note\n-----------", "Public note"],
    ["Public note\nacross two lines\n-----------", "Public note across two lines"]
  ])("uses a leading Setext heading as the page title", (content, expected) => {
    expect(publicNodeTitle(content)).toBe(expected);
  });

  it.each([
    { content: "```\nFake title\n---\n```\n\n# Real title", context: "fenced code" },
    { content: "> Quoted title\n---\n\n# Real title", context: "a blockquote" },
    { content: "- List item\n---\n\n# Real title", context: "a list" },
    { content: "    Indented code\n---\n\n# Real title", context: "indented code" }
  ])("does not treat text in $context as a Setext heading", ({ content }) => {
    expect(publicNodeTitle(content)).toBe("Real title");
  });
});

describe("publicNodeDescription", () => {
  it.each([
    "Public note\n===========",
    "Public note\n-----------"
  ])("skips a leading Setext heading", (heading) => {
    expect(publicNodeDescription(`${heading}\n\nVisible paragraph`)).toBe("Visible paragraph");
  });
});
