// @vitest-environment jsdom
import { AnonymousIdentity } from "@icp-sdk/core/agent";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditDocument } from "@/components/markdown-edit-document";
import { writeNodeAuthenticated } from "@/lib/vfs-client";
import type { WikiNode, WriteNodeResult } from "@/lib/types";

vi.mock("@/lib/vfs-client", () => ({ writeNodeAuthenticated: vi.fn() }));

const origin = "https://vault.kinic.xyz";
const ready = { type: "kinic-vault-picker-ready" };
const selection = {
  type: "kinic-vault-selection",
  vault: "0123456789abcdef0123456789abcdef",
  object: "fedcba9876543210fedcba9876543210"
};
const link = `[非公開資料](https://vault.kinic.xyz/embed/${selection.vault}/${selection.object})`;
const node: WikiNode = {
  path: "/Knowledge/example.md", etag: "test-etag", kind: "file", content: "Keep my original draft.",
  createdAt: "0", updatedAt: "0", metadataJson: "{}"
};

function editor(current = node, databaseId = "db_test", refresh = async () => current) {
  return <MarkdownEditDocument
    canisterId="test" databaseId={databaseId} node={current} isLargeContent={false}
    contentBytes={current.content.length} writeIdentity={new AnonymousIdentity()} onNodeSaved={refresh}
  />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((fulfilled, failed) => {
    resolve = fulfilled;
    reject = failed;
  });
  return { promise, resolve, reject };
}

// A real Window is required for MessageEvent.source. Stub only the popup boundary.
function createPopup() {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const popup = frame.contentWindow!;
  const postMessage = vi.spyOn(popup, "postMessage").mockImplementation(() => {});
  const close = vi.spyOn(popup, "close").mockImplementation(() => {});
  return { popup, postMessage, close };
}

function send(source: Window, data: unknown, from = origin) {
  act(() => window.dispatchEvent(new MessageEvent("message", { source, origin: from, data })));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.mocked(writeNodeAuthenticated).mockReset();
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

describe("Wiki editor Vault picker", () => {
  it("reconnects the owned picker after reload and inserts only once", async () => {
    const { popup, postMessage, close } = createPopup();
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { container } = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    send(popup, ready);
    postMessage.mockClear();

    // A reloaded document keeps its WindowProxy but restarts the handshake.
    send(popup, ready, "https://evil.example");
    send(window, ready);
    send(popup, { ...ready, extra: true });
    expect(postMessage).not.toHaveBeenCalled();
    send(popup, ready);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "kinic-vault-picker-connect" }, origin);
    send(popup, selection);
    send(popup, selection);
    await waitFor(() => expect([...container.querySelectorAll(".cm-line")].map((line) => line.textContent))
      .toEqual([node.content, "", link, ""]));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("inserts only one generic reference after the owned popup handshake", async () => {
    const { popup, postMessage, close } = createPopup();
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    const { container } = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    expect(open.mock.calls[0]?.slice(0, 2)).toEqual([`${origin}/pick`, "_blank"]);

    send(popup, selection);
    send(popup, ready, "https://evil.example");
    send(window, ready);
    send(popup, { ...ready, title: "extra" });
    send(popup, selection);
    expect(postMessage).not.toHaveBeenCalled();
    expect(container.querySelector(".cm-content")?.textContent).toBe(node.content);

    send(popup, ready);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "kinic-vault-picker-connect" }, origin);

    send(popup, selection, "https://evil.example");
    send(window, selection);
    send(popup, { ...selection, title: "Private title" });
    send(popup, { ...selection, object: selection.object.toUpperCase() });
    send(popup, { ...selection, object: selection.object + "\n" });
    send(popup, { ...selection, object: null });
    expect(container.querySelector(".cm-content")?.textContent).toBe(node.content);

    send(popup, selection);
    send(popup, selection);
    await waitFor(() => expect([...container.querySelectorAll(".cm-line")].map((line) => line.textContent))
      .toEqual([node.content, "", link, ""]));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("lets the editor retry a blocked popup", () => {
    const { popup, postMessage } = createPopup();
    vi.spyOn(window, "open").mockReturnValueOnce(null).mockReturnValueOnce(popup);
    render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    expect(screen.getByRole("status").textContent).toMatch(/blocked/i);

    fireEvent.click(screen.getByRole("button", { name: "Retry Vault picker" }));
    send(popup, ready);
    expect(screen.queryByRole("status")).toBeNull();
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "kinic-vault-picker-connect" }, origin);
  });

  it("closes the owned popup and fences delayed selection after changing article", () => {
    const { popup, close } = createPopup();
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { container, rerender } = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    send(popup, ready);

    rerender(editor({ ...node, path: "/Knowledge/other.md", content: "Other article." }));
    send(popup, selection);
    expect(close).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".cm-content")?.textContent).toBe("Other article.");
  });

  it("keeps the inserted reference in the original database when another database uses the same path", () => {
    const { popup } = createPopup();
    const pending = createPopup();
    vi.spyOn(window, "open").mockReturnValueOnce(popup).mockReturnValueOnce(pending.popup);
    const { container, rerender } = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    send(popup, ready);
    send(popup, selection);
    expect(container.querySelector(".cm-content")?.textContent).toContain(link);

    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    send(pending.popup, ready);
    rerender(editor({ ...node, content: "Different database." }, "db_other"));
    send(pending.popup, selection);
    expect(pending.close).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".cm-content")?.textContent).toBe("Different database.");
  });

  it.each(["success", "failure"] as const)("fences the draft and picker until refresh settles with %s", async (outcome) => {
    const initial = createPopup();
    const pending = createPopup();
    const next = createPopup();
    const open = vi.spyOn(window, "open")
      .mockReturnValueOnce(initial.popup).mockReturnValueOnce(pending.popup).mockReturnValueOnce(next.popup);
    const saved = { ...node, etag: "new-etag", content: `${node.content}\n\n${link}\n` };
    vi.mocked(writeNodeAuthenticated).mockResolvedValue({ node: saved, created: false });
    const refresh = deferred<WikiNode>();
    const refreshNode = vi.fn(() => refresh.promise);
    render(editor(node, "db_test", refreshNode));

    const insert = screen.getByRole<HTMLButtonElement>("button", { name: "Insert private document" });
    fireEvent.click(insert);
    send(initial.popup, ready);
    send(initial.popup, selection);
    fireEvent.click(insert);
    send(pending.popup, ready);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });

    expect(refreshNode).toHaveBeenCalledOnce();
    expect(pending.close).toHaveBeenCalledOnce();
    expect(insert.disabled).toBe(true);
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("false");
    fireEvent.click(insert);
    send(pending.popup, selection);
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox").querySelectorAll(".cm-line")).toHaveLength(4);

    await act(async () => {
      if (outcome === "success") refresh.resolve(saved);
      else refresh.reject(new Error("lookup unavailable"));
    });
    if (outcome === "failure") {
      expect(screen.getByText("Saved, but refresh failed: lookup unavailable")).toBeDefined();
    }
    expect(insert.disabled).toBe(false);
    expect(screen.getByRole("textbox").getAttribute("contenteditable")).toBe("true");
    fireEvent.click(insert);
    send(next.popup, ready);
    send(next.popup, selection);
    expect(screen.getByRole("textbox").textContent?.split(link)).toHaveLength(3);
  });

  it.each(["write", "refresh"] as const)("preserves a new article's dirty draft when the old article's %s completes", async (stage) => {
    const initial = createPopup();
    const next = createPopup();
    vi.spyOn(window, "open").mockReturnValueOnce(initial.popup).mockReturnValueOnce(next.popup);
    const saved = { ...node, etag: "new-etag", content: `${node.content}\n\n${link}\n` };
    const write = deferred<WriteNodeResult>();
    const refresh = deferred<WikiNode>();
    vi.mocked(writeNodeAuthenticated).mockReturnValue(stage === "write" ? write.promise : Promise.resolve({ node: saved, created: false }));
    const refreshNode = vi.fn(() => stage === "refresh" ? refresh.promise : Promise.resolve(saved));
    const { rerender } = render(editor(node, "db_test", refreshNode));

    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    send(initial.popup, ready);
    send(initial.popup, selection);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });

    rerender(editor({ ...node, content: "Different database." }, "db_other"));
    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    send(next.popup, ready);
    send(next.popup, selection);
    expect(screen.getByRole("textbox").textContent).toBe(`Different database.${link}`);

    await act(async () => {
      if (stage === "write") write.resolve({ node: saved, created: false });
      else refresh.resolve(saved);
    });
    expect(screen.getByRole("textbox").textContent).toBe(`Different database.${link}`);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(false);
  });

  it("closes the owned popup on editor unmount", () => {
    const { popup, close, postMessage } = createPopup();
    vi.spyOn(window, "open").mockReturnValue(popup);
    const { unmount } = render(editor());
    fireEvent.click(screen.getByRole("button", { name: "Insert private document" }));
    unmount();
    send(popup, ready);
    expect(close).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
  });
});
