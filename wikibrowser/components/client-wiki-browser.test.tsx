// @vitest-environment jsdom
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ClientWikiBrowser } from "./client-wiki-browser";

const calls = vi.hoisted(() => ({ imports: 0 }));
vi.mock("./wiki-browser", () => {
  calls.imports++;
  return { WikiBrowser: () => <button onClick={() => { document.title = "Wiki interaction works"; }}>Open wiki</button> };
});

it("leaves the editor SDK unloaded during SSR, then hydrates and enables interactions", async () => {
  const html = renderToString(<ClientWikiBrowser />);
  expect(calls.imports).toBe(0);
  expect(html).toContain("Loading wiki");
  expect(html).not.toContain("Open wiki");
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => { root = hydrateRoot(container, <ClientWikiBrowser />, { onRecoverableError: (error) => errors.push(error) }); });
    await vi.waitFor(() => expect(container.querySelector("button")).not.toBeNull());
    expect(calls.imports).toBe(1);
    container.querySelector("button")!.click();
    expect(document.title).toBe("Wiki interaction works");
    expect(errors).toEqual([]);
  } finally {
    await act(async () => { root?.unmount(); });
    container.remove();
  }
});
