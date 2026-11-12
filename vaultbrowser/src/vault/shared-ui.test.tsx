// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { Button } from "@kinic/ui/button";
import { Input } from "@kinic/ui/input";
import { VaultButton, VaultField } from "./ui";

afterEach(cleanup);

it("shared primitives forward native refs and custom presentation without adding wrappers", () => {
  const button = createRef<HTMLButtonElement>();
  const input = createRef<HTMLInputElement>();
  const clicked = vi.fn();
  const view = render(<><Button unstyled className="custom-button text-sm text-lg" ref={button} onClick={clicked}>Run</Button><Input unstyled className="custom-input" ref={input} aria-label="Shared input" /></>);
  expect(button.current?.className).toBe("custom-button text-sm text-lg");
  expect(input.current?.className).toBe("custom-input");
  fireEvent.click(view.getByRole("button"));
  expect(clicked).toHaveBeenCalledOnce();
  input.current?.focus();
  expect(document.activeElement).toBe(input.current);
});

it("Vault wrappers preserve no-autofill input and non-submitting action defaults", () => {
  const submitted = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  const view = render(<form onSubmit={submitted}><VaultField label="Secret" type="password" /><VaultButton>Reveal</VaultButton></form>);
  expect(view.getByLabelText("Secret").getAttribute("autocomplete")).toBe("off");
  fireEvent.click(view.getByRole("button"));
  expect(submitted).not.toHaveBeenCalled();
  expect(view.getByRole("button").getAttribute("type")).toBe("button");
});
