// @vitest-environment jsdom
import { AnonymousIdentity } from "@icp-sdk/core/agent";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditDocument } from "@/components/markdown-edit-document";
import type { WikiNode } from "@/lib/types";

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

function editor(current = node, databaseId = "db_test") {
  return <MarkdownEditDocument
    canisterId="test" databaseId={databaseId} node={current} isLargeContent={false}
    contentBytes={current.content.length} writeIdentity={new AnonymousIdentity()} onNodeSaved={async () => current}
  />;
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
  document.querySelectorAll("iframe").forEach((frame) => frame.remove());
});

describe("Wiki editor Vault picker", () => {
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
