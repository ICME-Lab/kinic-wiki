// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VaultDocuments } from "./documents";
import type { Item, VaultClient } from "@kinic/vault-client";
vi.mock("@kinic/ui/editor", () => ({ MarkdownEditor: () => <div /> }));
afterEach(cleanup);
const items = ["Title match", "Hidden body"].map((title, i) => ({ metadata: { kind: "note", title }, revision: { object: new Uint8Array(16).fill(i + 1), deleted: false } })) as Item[];
function setup() {
  let ticket = 0;
  const client = { session: { capture: () => ticket, check: (g: number) => { if (g !== ticket) throw Error("Locked"); }, addLockCleanup: () => () => {} }, searchNotes: vi.fn(), hasPendingSave: false } as unknown as VaultClient;
  let pending: Promise<void> | undefined;
  const props = { client, items, disabled: false, writesDisabled: false, refresh: vi.fn(), run: (f: () => Promise<void>) => { pending = f().catch(() => {}); } };
  const view = render(<VaultDocuments {...props} />);
  return { client, props, view, lock: () => ticket++, done: () => pending };
}
it("filters titles without reads, searches contents explicitly, and resets IDs when query/list changes", async () => {
  const x = setup();
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), { target: { value: "match" } });
  expect(screen.getByRole("button", { name: "Title match" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Hidden body" })).toBeNull();
  expect(x.client.searchNotes).not.toHaveBeenCalled();
  vi.mocked(x.client.searchNotes).mockResolvedValue([new Uint8Array(16).fill(2)]);
  fireEvent.click(screen.getByRole("button", { name: "Search note contents" }));
  await screen.findByRole("button", { name: "Hidden body" });
  expect(x.client.searchNotes).toHaveBeenCalledWith(items, "match");
  expect(screen.getByRole("button", { name: "Title match" })).toBeTruthy();
  x.view.rerender(<VaultDocuments {...x.props} items={[...items]} />);
  expect(screen.queryByRole("button", { name: "Hidden body" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), { target: { value: "none" } });
  expect(screen.queryByRole("button", { name: "Title match" })).toBeNull();
});
it.each(["lock", "unmount", "client", "items"])("discards late content search after %s and blocks query/reexecution while searching", async (reason) => {
  const x = setup();
  let resolve!: (ids: Uint8Array[]) => void;
  vi.mocked(x.client.searchNotes).mockImplementation(() => new Promise(r => { resolve = r; }));
  fireEvent.change(screen.getByLabelText("Search this Vault locally"), { target: { value: "match" } });
  fireEvent.click(screen.getByRole("button", { name: "Search note contents" }));
  expect((screen.getByLabelText("Search this Vault locally") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Search note contents" }) as HTMLButtonElement).disabled).toBe(true);
  if (reason === "lock") x.lock();
  if (reason === "unmount") x.view.unmount();
  if (reason === "client") x.view.rerender(<VaultDocuments {...x.props} client={{ ...x.client } as VaultClient} />);
  if (reason === "items") x.view.rerender(<VaultDocuments {...x.props} items={[...items]} />);
  await act(async () => { resolve([new Uint8Array(16).fill(2)]); await x.done(); });
  expect(screen.queryByRole("button", { name: "Hidden body" })).toBeNull();
});
