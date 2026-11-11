// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Session } from "@kinic/vault-client/session";
import { useRecoveryFiles, RecoveryFilePrompt } from "./recovery-files";
afterEach(cleanup);
it("requires a separate file selection and rejects late reads after lock", async () => {
  const session = new Session();
  let files!: ReturnType<typeof useRecoveryFiles>;
  function Harness() {
    files = useRecoveryFiles(session);
    return <RecoveryFilePrompt files={files} />;
  }
  render(<Harness />);
  let selected!: Promise<Uint8Array>;
  act(() => {
    selected = files.select("Reselect saved new kit", 4096);
  });
  const rejected = selected.catch((e) => e.message);
  let resolve!: (b: ArrayBuffer) => void;
  const file = {
    size: 3,
    arrayBuffer: () =>
      new Promise<ArrayBuffer>((r) => {
        resolve = r;
      }),
  };
  const input = screen.getByLabelText(
    "Reselect saved new kit",
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  act(() => session.lock());
  const raw = new Uint8Array([1, 2, 3]);
  await act(async () => {
    resolve(raw.buffer);
    await Promise.resolve();
  });
  expect(await rejected).toBe("Locked");
  expect(raw).toEqual(new Uint8Array(3));
  expect(screen.queryByLabelText("Reselect saved new kit")).toBeNull();
});
it("wipes selected bytes when the operation releases files and rejects selection cancellation", async () => {
  const session = new Session();
  let files!: ReturnType<typeof useRecoveryFiles>;
  function Harness() {
    files = useRecoveryFiles(session);
    return <RecoveryFilePrompt files={files} />;
  }
  render(<Harness />);
  let pending!: Promise<Uint8Array>;
  act(() => {
    pending = files.select("Select source kit", 4096);
  });
  const raw = new Uint8Array([7, 8]);
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Select source kit"), {
      target: { files: [{ size: 2, arrayBuffer: async () => raw.buffer }] },
    });
  });
  expect(await pending).toEqual(new Uint8Array([7, 8]));
  files.clear();
  expect(raw).toEqual(new Uint8Array(2));
  act(() => {
    pending = files.select("Select source kit", 4096);
  });
  const rejected = pending.catch((e) => e.message);
  fireEvent.click(screen.getByRole("button", { name: "Stop file selection" }));
  expect(await rejected).toBe("FileSelectionCancelled");
});
it("never opens a new file prompt from a stale continuation after lock", async () => {
  const session = new Session();
  let files!: ReturnType<typeof useRecoveryFiles>;
  function Harness() {
    files = useRecoveryFiles(session);
    return <RecoveryFilePrompt files={files} />;
  }
  render(<Harness />);
  act(() => session.lock());
  await expect(files.select("Stale new kit")).rejects.toThrow("Locked");
  expect(screen.queryByLabelText("Stale new kit")).toBeNull();
});
