// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { VaultClient } from "@kinic/vault-client";
import { VaultPortabilityPanel } from "./portability";

afterEach(cleanup);
function setup() {
  let epoch = 0;
  const cleanups = new Set<() => void>();
  const save = vi.fn(async () => ({}));
  const resumeSave = vi.fn(async () => ({}));
  const cancelSave = vi.fn(async () => ({ Cancelled: null }));
  const client = { save, resumeSave, cancelSave, hasPendingSave: false,
    session: { capture: () => epoch, check: (ticket: number) => { if (ticket !== epoch) throw Error("Locked"); }, addLockCleanup: (f: () => void) => { cleanups.add(f); return () => cleanups.delete(f); } },
  } as unknown as VaultClient;
  const props = { client, items: [], disabled: false, writesDisabled: false, refresh: vi.fn(async () => {}), onClose: vi.fn() };
  return { props, save, resumeSave, cancelSave, lock: () => { epoch++; for (const f of cleanups) f(); } };
}
const envelope = (bodies: string[]) => JSON.stringify({ format: "kinic-vault-export", items: bodies.map((body, i) => ({ kind: "note", title: `Item ${i}`, body })) });
async function load(content: string | Promise<string>) {
  fireEvent.change(screen.getByLabelText("Select CSV or JSON file"), { target: { files: [{ name: "vault.json", size: 1, text: () => Promise.resolve(content) }] } });
}
it("reports oversized UTF-8 items and retains them while saving boundary-sized items", async () => {
  const x = setup(); render(<VaultPortabilityPanel {...x.props} />);
  await load(envelope(["x".repeat(262144), "x".repeat(262145), "あ".repeat(87382), "ok"]));
  fireEvent.click(await screen.findByRole("button", { name: "Import 4 item(s)" }));
  await screen.findByText(/2 item\(s\) exceed the 256 KiB limit/);
  expect(x.save).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/Item 1.*256 KiB/)).toBeTruthy();
  expect(screen.getByText(/Item 2.*256 KiB/)).toBeTruthy();
});
it("retries only unsaved items after a definite error", async () => {
  const x = setup(); x.save.mockResolvedValueOnce({}).mockRejectedValueOnce(Error("Offline")).mockResolvedValue({});
  render(<VaultPortabilityPanel {...x.props} />);
  await load(envelope(["one", "two", "three"]));
  fireEvent.click(await screen.findByRole("button", { name: "Import 3 item(s)" }));
  await screen.findByText(/before an error occurred/);
  fireEvent.click(screen.getByRole("button", { name: "Import 2 item(s)" }));
  await screen.findByText(/Imported 2 item/);
  expect(x.save).toHaveBeenCalledTimes(4);
});
it("does not resurrect a parsed file after lock", async () => {
  const x = setup(); render(<VaultPortabilityPanel {...x.props} />);
  let finish!: (v: string) => void;
  await load(new Promise<string>(resolve => { finish = resolve; }));
  act(() => x.lock());
  await act(async () => finish(envelope(["secret"])));
  expect(screen.queryByText(/item\(s\) found/)).toBeNull();
});
it("a parent rerender does not stop a running import", async () => {
  const x = setup(); let finish!: () => void;
  x.save.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
  const view = render(<VaultPortabilityPanel {...x.props} />);
  await load(envelope(["one", "two"]));
  fireEvent.click(await screen.findByRole("button", { name: "Import 2 item(s)" }));
  await waitFor(() => expect(x.save).toHaveBeenCalledTimes(1));
  view.rerender(<VaultPortabilityPanel {...x.props} onClose={() => {}} />);
  await act(async () => finish());
  await waitFor(() => expect(x.save).toHaveBeenCalledTimes(2));
});
it("resolves an ambiguous save before retrying the remaining import", async () => {
  const x = setup();
  x.save.mockImplementationOnce(async () => { Object.assign(x.props.client, { hasPendingSave: true }); throw Error("NetworkError"); });
  x.resumeSave.mockImplementation(async () => { Object.assign(x.props.client, { hasPendingSave: false }); return {}; });
  render(<VaultPortabilityPanel {...x.props} />);
  await load(envelope(["one", "two"]));
  fireEvent.click(await screen.findByRole("button", { name: "Import 2 item(s)" }));
  fireEvent.click(await screen.findByRole("button", { name: "Resolve import save" }));
  await screen.findByRole("button", { name: "Import 1 item(s)" });
  fireEvent.click(screen.getByRole("button", { name: "Import 1 item(s)" }));
  await screen.findByText(/Imported 1 item/);
  expect(x.save).toHaveBeenCalledTimes(2);
  expect(x.resumeSave).toHaveBeenCalledTimes(1);
});

it("ignores an older file read that finishes after a newer selection", async () => {
  const x = setup(); render(<VaultPortabilityPanel {...x.props} />);
  let finish!: (v: string) => void;
  await load(new Promise<string>(resolve => { finish = resolve; }));
  await load(envelope(["new", "newer"]));
  await screen.findByRole("button", { name: "Import 2 item(s)" });
  await act(async () => finish(envelope(["old"])));
  expect(screen.getByRole("button", { name: "Import 2 item(s)" })).toBeTruthy();
});
it("stops after the in-flight save and retries only the remaining items", async () => {
  const x = setup(); let finish!: () => void;
  x.save.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
  render(<VaultPortabilityPanel {...x.props} />);
  await load(envelope(["one", "two", "three"]));
  fireEvent.click(await screen.findByRole("button", { name: "Import 3 item(s)" }));
  fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
  await act(async () => finish());
  await screen.findByText(/Import stopped after 1/);
  fireEvent.click(screen.getByRole("button", { name: "Import 2 item(s)" }));
  await screen.findByText(/Imported 2 item/);
  expect(x.save).toHaveBeenCalledTimes(3);
});

it("allows cancellation of an owned save after funding becomes unavailable", async () => {
  const x = setup();
  x.save.mockImplementationOnce(async () => { Object.assign(x.props.client, { hasPendingSave: true }); throw Error("NetworkError"); });
  x.cancelSave.mockImplementation(async () => { Object.assign(x.props.client, { hasPendingSave: false }); return { Cancelled: null }; });
  const view = render(<VaultPortabilityPanel {...x.props} />);
  await load(envelope(["one"]));
  fireEvent.click(await screen.findByRole("button", { name: "Import 1 item(s)" }));
  await screen.findByRole("button", { name: "Resolve import save" });
  view.rerender(<VaultPortabilityPanel {...x.props} writesDisabled />);
  const cancel = screen.getByRole("button", { name: "Cancel unfinished import save" }) as HTMLButtonElement;
  expect(cancel.disabled).toBe(false);
  fireEvent.click(cancel);
  await screen.findByText(/Unfinished import save cancelled/);
});
it("releases ownership after a definitive resume rejection without losing the item", async () => {
  const x = setup();
  x.save.mockImplementationOnce(async () => { Object.assign(x.props.client, { hasPendingSave: true }); throw Error("NetworkError"); });
  x.resumeSave.mockImplementation(async () => { Object.assign(x.props.client, { hasPendingSave: false }); throw Error("InsufficientCredit"); });
  render(<VaultPortabilityPanel {...x.props} />);
  await load(envelope(["one"]));
  fireEvent.click(await screen.findByRole("button", { name: "Import 1 item(s)" }));
  fireEvent.click(await screen.findByRole("button", { name: "Resolve import save" }));
  await screen.findByText(/Could not resolve import save/);
  expect(screen.queryByRole("button", { name: "Resolve import save" })).toBeNull();
  const retry = screen.getByRole("button", { name: "Import 1 item(s)" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  fireEvent.click(retry);
  await screen.findByText(/Imported 1 item/);
});
