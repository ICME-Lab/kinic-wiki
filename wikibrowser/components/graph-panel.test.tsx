// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { GraphPanel } from "./graph-panel";

vi.mock("@/components/wiki-navigation", () => ({
  WikiNavigationLink: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>
}));
vi.mock("@/lib/vfs-client", () => ({
  graphLinks: async () => Array.from({ length: 30 }, (_, index) => ({
    sourcePath: "/Knowledge/Hub", targetPath: `/Knowledge/Note${index.toString().padStart(2, "0")}`,
    rawHref: `[[Note${index}]]`, linkText: ""
  })),
  graphNeighborhood: vi.fn()
}));
afterEach(cleanup);

it("reveals an omitted graph label when its link gains focus and resets on blur", async () => {
  render(<GraphPanel canisterId="aaaaa-aa" databaseId="db" centerPath={null} depth={1} readIdentity={null} />);
  const link = await screen.findByRole("link", { name: "Knowledge/Note29" });
  expect(link.querySelector("text")).toBeNull();
  fireEvent.focus(link);
  expect(link.querySelector("text")?.textContent).toBe("Knowledge/Note29");
  fireEvent.blur(link);
  expect(link.querySelector("text")).toBeNull();
});
