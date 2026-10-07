// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@/lib/vfs-client", () => ({ listDatabasesPublic: vi.fn().mockResolvedValue([]) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: () => "/cycles"
}));
import { CommandPalette, paletteItems } from "./command-palette";
afterEach(() => { cleanup(); navigate.mockClear(); });

describe("command palette keyboard interactions", () => {
  it("ignores composing Enter and arrow keys, including Safari's keyCode 229", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox");
    const selected = input.getAttribute("aria-activedescendant");
    for (const key of ["Enter", "ArrowDown", "ArrowUp"]) {
      fireEvent.keyDown(input, { key, isComposing: true });
      fireEvent.keyDown(input, { key, keyCode: 229 });
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-activedescendant")).toBe(selected);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).not.toBe(selected);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith({ to: "/marketplace" });
  });

  it.each(["Escape", "shortcut", "close button"])("restores the invoking input after %s", async (method) => {
    render(<><input aria-label="Amount" /><CommandPalette /></>);
    const amount = screen.getByRole("textbox", { name: "Amount" });
    amount.focus();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(screen.getByRole("combobox"));
    if (method === "Escape") fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    else if (method === "shortcut") fireEvent.keyDown(window, { key: "k", metaKey: true });
    else fireEvent.click(screen.getByRole("button", { name: "Close commands" }));
    await waitFor(() => expect(document.activeElement).toBe(amount));
  });
});

describe("command palette destinations", () => {
  it("filters global destinations without a database", () => {
    expect(paletteItems("dash", null, []).map((item) => item.href)).toEqual(["/dashboard"]);
    expect(paletteItems("not-a-command", null, [])).toEqual([]);
  });
  it("offers full-text search only within the current database", () => {
    const items = paletteItems("a & b", "db_example", []);
    expect(items[0].href).toBe("/db/db_example/search?q=a+%26+b&kind=full");
    expect(items[0].detail).toContain("Current database");
  });
  it("offers contextual knowledge, graph and management destinations", () => {
    const hrefs = paletteItems("", "db_example", []).map((item) => item.href);
    expect(hrefs).toContain("/db/db_example/Knowledge");
    expect(hrefs).toContain("/db/db_example/graph");
    expect(hrefs).toContain("/dashboard/project/db_example");
  });
});
