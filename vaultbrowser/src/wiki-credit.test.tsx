// @vitest-environment jsdom
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import type { VaultClient } from "@kinic/vault-client";
const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  prepare: vi.fn(),
  status: vi.fn(),
  revoke: vi.fn(),
  autoStatus: vi.fn(),
  autoRequest: vi.fn(),
}));
vi.mock("./wiki-credit-actor", () => ({
  creditOrigins: () => ({
    wiki: "https://wiki.kinic.xyz",
    vault: "https://vault.kinic.xyz",
  }),
  vaultCreditActor: async () => ({
    begin_wiki_link: mocks.begin,
    prepare_wiki_credit: mocks.prepare,
    wiki_link_status: mocks.status,
    revoke_wiki_link: mocks.revoke,
    wiki_auto_topup_status: mocks.autoStatus,
    request_wiki_auto_topup: mocks.autoRequest,
  }),
}));
import { WikiCreditFunding } from "./wiki-credit";
const principal = Principal.fromText("aaaaa-aa");
let generation = 0;
const client = () =>
  ({
    identity: { getPrincipal: () => principal },
    session: { capture: () => generation },
    canister: "aaaaa-aa",
  }) as unknown as VaultClient;
let popup: {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
  location: { replace: ReturnType<typeof vi.fn> };
  postMessage: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  generation = 0;
  mocks.status.mockResolvedValue({ Ok: [] });
  mocks.autoStatus.mockResolvedValue({ Ok: [] });
  popup = {
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
    postMessage: vi.fn(),
  };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it("opens its mobile popup before the challenge await and navigates only to fixed Wiki origin", async () => {
  let resolve!: (v: unknown) => void;
  mocks.begin.mockReturnValue(new Promise((r) => (resolve = r)));
  render(<WikiCreditFunding client={client()} onFunded={async () => {}} />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Link Wiki account" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Link Wiki account" }));
  expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
  expect(popup.location.replace).not.toHaveBeenCalled();
  resolve({
    Ok: {
      challenge: new Uint8Array(16).fill(1),
      vault_owner: principal,
      generation: 1n,
      expires_at_ns: 999n,
    },
  });
  await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
  expect(popup.location.replace.mock.calls[0][0]).toMatch(
    /^https:\/\/wiki.kinic.xyz\/vault-credit#mode=link&id=0101/,
  );
});
it("late challenge on a replaced same-Principal client cannot navigate an owned window", async () => {
  let resolve!: (v: unknown) => void;
  mocks.begin.mockReturnValue(new Promise((r) => (resolve = r)));
  const view = render(
    <WikiCreditFunding client={client()} onFunded={async () => {}} />,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Link Wiki account" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Link Wiki account" }));
  view.rerender(
    <WikiCreditFunding client={client()} onFunded={async () => {}} />,
  );
  resolve({
    Ok: {
      challenge: new Uint8Array(16),
      vault_owner: principal,
      generation: 1n,
      expires_at_ns: 999n,
    },
  });
  await waitFor(() => expect(popup.close).toHaveBeenCalled());
  expect(popup.location.replace).not.toHaveBeenCalled();
});
it("wrong source and nonce cannot prepare; matching offered ID uses the authenticated actor and stale ready is fenced", async () => {
  mocks.status.mockResolvedValue({
    Ok: [
      {
        wiki_owner: principal,
        vault_owner: principal,
        generation: 1n,
        active: true,
      },
    ],
  });
  let resolve!: (v: unknown) => void;
  mocks.prepare.mockReturnValue(new Promise((r) => (resolve = r)));
  const c = client();
  const view = render(
    <WikiCreditFunding client={c} onFunded={async () => {}} />,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Charge from Wiki credits" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Charge from Wiki credits" }),
  );
  await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
  const nonce = new URLSearchParams(
    new URL(popup.location.replace.mock.calls[0][0]).hash.slice(1),
  ).get("nonce");
  const data = {
    protocol: "kinic-credit-v1",
    type: "offer",
    nonce,
    id: "04".repeat(16),
  };
  for (const [origin, source, payload] of [
    ["https://evil.test", popup, data],
    ["https://wiki.kinic.xyz", {}, data],
    ["https://wiki.kinic.xyz", popup, { ...data, nonce: "00".repeat(32) }],
  ] as const)
    fireEvent(
      window,
      new MessageEvent("message", {
        origin,
        source: source as unknown as Window,
        data: payload,
      }),
    );
  expect(mocks.prepare).not.toHaveBeenCalled();
  fireEvent(
    window,
    new MessageEvent("message", {
      origin: "https://wiki.kinic.xyz",
      source: popup as unknown as Window,
      data,
    }),
  );
  expect(mocks.prepare).toHaveBeenCalledWith(new Uint8Array(16).fill(4));
  view.rerender(
    <WikiCreditFunding client={client()} onFunded={async () => {}} />,
  );
  resolve({
    Ok: {
      status: { Prepared: null },
      offer: { operation: new Uint8Array(16).fill(4), vault_owner: principal },
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(popup.postMessage).not.toHaveBeenCalled();
});
it("a blocked mobile popup does not create a backend challenge", async () => {
  vi.mocked(window.open).mockReturnValue(null);
  render(<WikiCreditFunding client={client()} onFunded={async () => {}} />);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Link Wiki account" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Link Wiki account" }));
  expect(mocks.begin).not.toHaveBeenCalled();
  expect(screen.getByText(/Allow popups/)).toBeTruthy();
});
it.each(["completed", "canceled with prepare pending"])(
  "fresh charge after %s gets a new window/nonce and rejects the old prepare response",
  async (state) => {
    mocks.status.mockResolvedValue({
      Ok: [
        {
          wiki_owner: principal,
          vault_owner: principal,
          generation: 1n,
          active: true,
        },
      ],
    });
    window.history.replaceState(
      null,
      "",
      `/#mode=fund&id=${"01".repeat(16)}&nonce=${"aa".repeat(32)}`,
    );
    let resolveFirst!: (value: unknown) => void;
    const secondPopup = {
      closed: false,
      close: vi.fn(),
      location: { replace: vi.fn() },
      postMessage: vi.fn(),
    };
    mocks.prepare
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({
        Ok: {
          status: { Prepared: null },
          offer: {
            operation: new Uint8Array(16).fill(2),
            vault_owner: principal,
          },
        },
      });
    vi.mocked(window.open)
      .mockReturnValueOnce(popup as unknown as Window)
      .mockReturnValueOnce(secondPopup as unknown as Window);
    render(<WikiCreditFunding client={client()} onFunded={async () => {}} />);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Charge from Wiki credits" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Charge from Wiki credits" }),
    );
    await waitFor(() => expect(popup.location.replace).toHaveBeenCalled());
    const firstParams = new URLSearchParams(
      new URL(popup.location.replace.mock.calls[0][0]).hash.slice(1),
    );
    const send = (
      target: typeof popup,
      nonce: string,
      id: string,
      type = "offer",
    ) =>
      fireEvent(
        window,
        new MessageEvent("message", {
          origin: "https://wiki.kinic.xyz",
          source: target as unknown as Window,
          data: { protocol: "kinic-credit-v1", type, nonce, id },
        }),
      );
    send(popup, firstParams.get("nonce")!, "01".repeat(16));
    const receipt = {
      Ok: {
        status: { Prepared: null },
        offer: {
          operation: new Uint8Array(16).fill(1),
          vault_owner: principal,
        },
      },
    };
    if (state === "completed") {
      resolveFirst(receipt);
      await waitFor(() => expect(popup.postMessage).toHaveBeenCalled());
      send(popup, firstParams.get("nonce")!, "01".repeat(16), "result");
    }
    send(popup, firstParams.get("nonce")!, "03".repeat(16));
    send(popup, firstParams.get("nonce")!, "03".repeat(16), "hello");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(
      popup.postMessage.mock.calls.some(
        ([message]) => message.id === "03".repeat(16),
      ),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Charge from Wiki credits" }),
    );
    await waitFor(() =>
      expect(secondPopup.location.replace).toHaveBeenCalled(),
    );
    const nextParams = new URLSearchParams(
      new URL(secondPopup.location.replace.mock.calls[0][0]).hash.slice(1),
    );
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(nextParams.get("nonce")).not.toBe(firstParams.get("nonce"));
    expect(nextParams.get("id")).not.toBe(firstParams.get("id"));
    send(secondPopup, firstParams.get("nonce")!, "01".repeat(16));
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    send(secondPopup, nextParams.get("nonce")!, "02".repeat(16));
    await waitFor(() =>
      expect(secondPopup.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "ready", id: "02".repeat(16) }),
        "https://wiki.kinic.xyz",
      ),
    );
    if (state !== "completed") {
      resolveFirst(receipt);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(popup.postMessage).not.toHaveBeenCalled();
    }
    expect(
      secondPopup.postMessage.mock.calls.some(
        ([message]) => message.id === "01".repeat(16),
      ),
    ).toBe(false);
    window.history.replaceState(null, "", "/");
  },
);

const linked = {
  wiki_owner: principal,
  vault_owner: principal,
  generation: 1n,
  active: true,
};
const autoPolicy = {
  policy: {
    database_id: "db1",
    threshold_cycles: 1_000n,
    amount_cycles: 50_000_000_000n,
    daily_limit_cycles: 200_000_000_000n,
    min_database_cycles: 0n,
  },
  database_name: "Research",
  sent_today_cycles: 0n,
  last_topup_at_ns: [],
};
it("shows the standing Wiki refill and asks for one only below its threshold", async () => {
  mocks.status.mockResolvedValue({ Ok: [linked] });
  mocks.autoStatus.mockResolvedValue({ Ok: [autoPolicy] });
  mocks.autoRequest.mockResolvedValue({
    Ok: [
      {
        offer: { amount_cycles: 50_000_000_000n },
        status: { Accepted: null },
      },
    ],
  });
  const funded = vi.fn(async () => {});
  // One client for the session: a replaced client fences late replies.
  const session = client();
  const view = render(
    <WikiCreditFunding client={session} onFunded={funded} balance={5_000n} />,
  );
  await screen.findByText("Auto top-up on");
  expect(screen.getByText(/Adds 50.00B from Research/)).toBeTruthy();
  expect(mocks.autoRequest).not.toHaveBeenCalled();
  view.rerender(
    <WikiCreditFunding client={session} onFunded={funded} balance={500n} />,
  );
  await screen.findByText("Refilled 50.00B cycles from Wiki.");
  expect(mocks.autoRequest).toHaveBeenCalledTimes(1);
  expect(funded).toHaveBeenCalledTimes(1);
  // A later render below the threshold does not ask again within a minute.
  view.rerender(
    <WikiCreditFunding client={session} onFunded={funded} balance={400n} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(mocks.autoRequest).toHaveBeenCalledTimes(1);
});
it("without a Wiki refill policy offers setup and never asks", async () => {
  mocks.status.mockResolvedValue({ Ok: [linked] });
  render(
    <WikiCreditFunding client={client()} onFunded={async () => {}} balance={0n} />,
  );
  await screen.findByText("Auto top-up off");
  expect(screen.getByRole("button", { name: "Set up in Wiki" })).toBeTruthy();
  expect(mocks.autoRequest).not.toHaveBeenCalled();
});
