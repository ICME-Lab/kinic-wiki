// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminShell } from "@/components/admin-shell";

const mocks = vi.hoisted(() => ({
  session: {} as Record<string, unknown>
}));

vi.mock("@/lib/app-router", () => ({ useAppPathname: () => "/cycles" }));
vi.mock("@/components/app-link", () => ({
  AppLink: ({ children, href, ...props }: { children?: ReactNode; href: string; [key: string]: unknown }) => <a href={href} {...props}>{children}</a>
}));
vi.mock("@/app/app-session-provider", () => ({ useAppSession: () => mocks.session }));

beforeEach(() => {
  mocks.session = {
    authControlsLocked: true,
    authLoading: false,
    authReady: true,
    login: vi.fn(),
    logout: vi.fn(),
    principal: null
  };
});

afterEach(cleanup);

describe("AdminShell account controls", () => {
  it("locks the sidebar Internet Identity login while auth controls are locked", () => {
    render(<AdminShell>content</AdminShell>);

    for (const button of screen.getAllByRole("button", { name: "Sign in with Internet Identity" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("locks the sidebar logout while auth controls are locked", () => {
    mocks.session.principal = "principal-1";
    render(<AdminShell>content</AdminShell>);

    for (const button of screen.getAllByRole("button", { name: "Log out" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
