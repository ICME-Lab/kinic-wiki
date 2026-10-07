// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./markdown-editor";

afterEach(cleanup);

it("uses a theme variable for Markdown URL syntax instead of the light-only fallback", async () => {
  const { container } = render(<MarkdownEditor
    content="[Reference](https://example.com)" disabled={false} lineCount={1} byteCount={32}
    saveState="idle" error={null} warning={null} onChange={vi.fn()} onRevert={vi.fn()} onSave={vi.fn()}
  />);
  await waitFor(() => {
    const url = [...container.querySelectorAll(".cm-content span")].find((span) => span.textContent === "https://example.com");
    expect(url).toBeDefined();
    const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]);
    const colors = rules.filter((rule): rule is CSSStyleRule => "selectorText" in rule)
      .filter((rule) => [...url!.classList].some((name) => rule.selectorText === `.${name}`))
      .map((rule) => rule.style.color);
    expect(colors).toContain("rgb(var(--accent-text))");
    expect(colors).not.toContain("#219");
  });
});
