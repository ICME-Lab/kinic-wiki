// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { nodeRequestKey } from "./request-keys";
import { useRequestScope } from "./use-request-scope";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const original = nodeRequestKey("canister", "db", "/Knowledge/A", "reader");

it.each([
  ["folder", nodeRequestKey("canister", "db", "/Knowledge/B", "reader")],
  ["database", nodeRequestKey("canister", "other-db", "/Knowledge/A", "reader")],
  ["principal", nodeRequestKey("canister", "db", "/Knowledge/A", null)],
  ["canister", nodeRequestKey("other-canister", "db", "/Knowledge/A", "reader")]
])("preserves the current listing when an old response arrives after changing %s", async (_, nextKey) => {
  const response = deferred<string>();
  const cache = new Map<string, string>();
  const { result, rerender } = renderHook(({ requestKey }) => {
    const isCurrent = useRequestScope(requestKey);
    const [listing, setListing] = useState("Current listing");
    return {
      listing,
      refresh: async (response: Promise<string>) => {
        const data = await response;
        cache.set(requestKey, data);
        if (isCurrent()) setListing(data);
      }
    };
  }, { initialProps: { requestKey: original } });

  const pending = result.current.refresh(response.promise);
  rerender({ requestKey: nextKey });
  await act(async () => {
    await result.current.refresh(Promise.resolve("New folder listing"));
  });
  expect(result.current.listing).toBe("New folder listing");
  await act(async () => {
    response.resolve("Old folder listing");
    await pending;
  });
  expect(result.current.listing).toBe("New folder listing");
  expect(cache.get(original)).toBe("Old folder listing");
});

it("keeps the current scope valid across rerenders and StrictMode effect replay", () => {
  const { result, rerender } = renderHook(({ requestKey }) => useRequestScope(requestKey), {
    initialProps: { requestKey: original },
    wrapper: StrictMode
  });
  const current = result.current;
  expect(current()).toBe(true);
  rerender({ requestKey: original });
  expect(result.current).toBe(current);
  expect(current()).toBe(true);
});

it("does not reactivate an old response after navigating away and back", () => {
  const { result, rerender, unmount } = renderHook(({ requestKey }) => useRequestScope(requestKey), {
    initialProps: { requestKey: original }
  });
  const old = result.current;
  rerender({ requestKey: "other" });
  rerender({ requestKey: original });
  expect(old()).toBe(false);
  const current = result.current;
  expect(current()).toBe(true);
  unmount();
  expect(current()).toBe(false);
});
