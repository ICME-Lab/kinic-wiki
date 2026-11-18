// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "@/components/markdown-preview";
import { PublicMarkdownPreview } from "@/components/public-markdown-preview";
import { ServerMarkdownPreview } from "@/components/server-markdown-preview";

const vaultId = "0123456789abcdef0123456789abcdef";
const objectId = "fedcba9876543210fedcba9876543210";
const path = `/embed/${vaultId}/${objectId}`;
const url = `https://vault.kinic.xyz${path}`;
const reference = `[非公開資料](${url})`;
const article = { canisterId: "test", databaseId: "db_abc", nodePath: "/Knowledge/a.md" };

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("Wiki Vault reference", () => {
  it("mounts the sandboxed vault frame only when opened and removes it when closed", () => {
    render(<MarkdownPreview {...article} content={reference} />);
    const open = screen.getByRole("button", { name: "Open private document" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("iframe")).toBeNull();

    fireEvent.click(open);
    const frame = screen.getByTitle("Private Vault document");
    expect(frame.getAttribute("src")).toBe(url);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("sandbox")?.split(" ").sort()).toEqual([
      "allow-downloads", "allow-popups", "allow-popups-to-escape-sandbox", "allow-same-origin", "allow-scripts"
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Close private document" }));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("keeps the same open frame when the article rerenders with the same reference", () => {
    const { rerender } = render(<MarkdownPreview {...article} content={reference} />);
    fireEvent.click(screen.getByRole("button", { name: "Open private document" }));
    const frame = screen.getByTitle("Private Vault document");

    rerender(<MarkdownPreview {...article} content={reference} />);
    expect(screen.getByTitle("Private Vault document")).toBe(frame);
    rerender(<MarkdownPreview {...article} content={`${reference}\n\nAdditional paragraph.`} />);
    expect(screen.getByTitle("Private Vault document")).toBe(frame);
  });

  it("requires a fresh click when the object or article changes", () => {
    const otherUrl = `https://vault.kinic.xyz/embed/${vaultId}/${vaultId}`;
    const otherReference = `[非公開資料](${otherUrl})`;
    const { rerender } = render(<MarkdownPreview {...article} content={reference} />);
    fireEvent.click(screen.getByRole("button", { name: "Open private document" }));

    rerender(<MarkdownPreview {...article} content={otherReference} />);
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open private document" }));
    expect(screen.getByTitle("Private Vault document").getAttribute("src")).toBe(otherUrl);

    rerender(<MarkdownPreview {...article} nodePath="/Knowledge/b.md" content={otherReference} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "Open private document" })).toBeDefined();
  });

  it.each([
    `\`\`\`md\n${reference}\n\`\`\``,
    `\`${reference}\``,
    `\\${reference}`,
    `Read ${reference}`,
    `${reference} after`,
    `[非公開資料](${url} "Vault title")`,
    `[非公開資料][r]\n\n[r]: ${url}`,
    `[非公開資料](${url.replace("/embed/", "/embed/../embed/")})`,
    `[非公開資料](${url.replace("/embed/", "/%65mbed/")})`,
    `[非公開資料](${url.replace("/embed/", "/&#101;mbed/")})`,
    `[非公開資料](https://user@vault.kinic.xyz${path})`,
    `[非公開資料](https://vault.kinic.xyz.evil.example${path})`,
    `[非公開資料](https://vault.kinic.xyz:443${path})`,
    `[非公開資料](http://vault.kinic.xyz${path})`,
    `[非公開資料](${url}?)`,
    `[非公開資料](${url}#)`,
    `[非公開資料](${url}/)`,
    `[非公開資料](${url.slice(0, -1)})`,
    `[非公開資料](${url.slice(0, -1)}A)`,
    `[Ordinary label](${url})`,
    "<iframe src='https://vault.kinic.xyz'></iframe>"
  ])("keeps ordinary Markdown inert as a private embed: %s", (content) => {
    const { container } = render(<MarkdownPreview {...article} content={content} />);
    expect(within(container).queryByRole("button")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("serves a generic link in static and public output", () => {
    for (const preview of [
      <MarkdownPreview key="article" {...article} content={reference} />,
      <ServerMarkdownPreview key="server" {...article} content={reference} />,
      <PublicMarkdownPreview key="public" content={reference} />
    ]) {
      const html = renderToStaticMarkup(preview);
      expect(html).toContain(`href="${url}"`);
      expect(html).toContain(">非公開資料</a>");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<button");
    }
  });

  it("hydrates the generic article link into a collapsed card", async () => {
    const preview = <MarkdownPreview {...article} content={reference} />;
    const container = document.createElement("main");
    document.body.append(container);
    container.innerHTML = renderToString(preview);
    const recoverableError = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(container, preview, { onRecoverableError: recoverableError });
      });
      expect(recoverableError).not.toHaveBeenCalled();
      expect(within(container).getByRole("button", { name: "Open private document" })).toBeDefined();
      expect(container.querySelector("iframe")).toBeNull();
    } finally {
      act(() => root?.unmount());
      container.remove();
    }
  });

  it("accepts a configured loopback Vault canister origin in dev", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_LOCAL_VAULT_ORIGIN", "http://vault-id.localhost:8024");
    render(<MarkdownPreview {...article} content={`[非公開資料](http://vault-id.localhost:8024${path})`} />);
    expect(screen.getByRole("button", { name: "Open private document" })).toBeDefined();
  });

  it.each([
    [true, "https://vault.kinic.xyz.evil.example"],
    [true, "http://vault.localhost.evil.example"],
    [true, "http://vault.localhost:8024/path"],
    [true, "http://user@vault.localhost:8024"],
    [true, "http://localhost:3000"],
    [false, "http://vault.localhost:8024"]
  ] as const)("keeps the production origin when dev=%s and override=%s is disallowed", (dev, origin) => {
    vi.stubEnv("DEV", dev);
    vi.stubEnv("VITE_LOCAL_VAULT_ORIGIN", origin);
    const { container } = render(<MarkdownPreview {...article} content={`[非公開資料](${origin}${path})\n\n${reference}`} />);
    expect(within(container).getAllByRole("button", { name: "Open private document" })).toHaveLength(1);
    expect(within(container).getByRole("link", { name: "非公開資料" }).getAttribute("href")).toBe(`${origin}${path}`);
  });
});
