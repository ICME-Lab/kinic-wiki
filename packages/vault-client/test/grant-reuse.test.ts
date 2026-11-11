import { afterEach, expect, it, vi } from "vitest";
import { Principal } from "@icp-sdk/core/principal";
import { IncidentClient } from "../src/incident";
import type {
  GrantRequest,
  GrantPurpose,
  Generation,
  VaultActor,
} from "../src/contracts";
vi.mock("../src/webauthn", () => ({
  assertCredential: vi.fn(async () => "real-proof-boundary-mocked"),
}));
afterEach(() => vi.restoreAllMocks());
const bytes = (n: number, length = 16) => new Uint8Array(length).fill(n);
function fixture() {
  const owner = Principal.selfAuthenticating(bytes(1, 32)),
    canister = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  const generation: Generation = {
    version: 2,
    owner,
    canister,
    vault: bytes(1),
    epoch: 0n,
    nonce: bytes(2, 32),
    key_name: "key_1",
  };
  const purpose: GrantPurpose = {
    Incident: { job: bytes(3), vector_digest: bytes(4, 32) },
  };
  let request: GrantRequest,
    complete = false;
  const begin = vi.fn(async (r: GrantRequest) => {
    request = r;
    return {
      Ok: {
        bytes: bytes(5, 32),
        registration: false,
        credential_ids: [r.credential],
        expires: BigInt(Math.floor(Date.now() / 1000) + 120),
      },
    };
  });
  const mutate = vi.fn(async () => ({ Ok: { Unit: null } }) as any);
  const actor = {
    begin_grant: begin,
    finish_grant: async () => ({
      Ok: {
        id: bytes(6, 32),
        expires: BigInt(Math.floor(Date.now() / 1000) + 60),
        next_counter: 0n,
        purpose: request.purpose,
        generations: request.generations,
      },
    }),
    mutate,
    incident_status: async () => ({
      Ok: [
        {
          job: bytes(3),
          complete,
          completed_digest: complete ? [bytes(7, 32)] : [],
          targets: [
            {
              source: { generation: [generation] },
              phase: { BackupVerified: null },
            },
          ],
        },
      ],
    }),
    incident_cutover_digest: async () => ({ Ok: bytes(7, 32) }),
  } as unknown as VaultActor;
  return {
    client: new IncidentClient(actor, owner, canister, "localhost", true),
    generation,
    purpose,
    begin,
    mutate,
    complete: () => {
      complete = true;
    },
  };
}
it("reuses only identical unexpired credential/purpose/full generation bindings", async () => {
  const f = fixture();
  await f.client.ensureAuthenticated(bytes(8), f.purpose, [f.generation]);
  await f.client.ensureAuthenticated(bytes(8), structuredClone(f.purpose), [
    { ...f.generation },
  ]);
  expect(f.begin).toHaveBeenCalledTimes(1);
  for (const [key, purpose, generation] of [
    [bytes(9), f.purpose, f.generation],
    [
      bytes(9),
      { Incident: { job: bytes(10), vector_digest: bytes(4, 32) } },
      f.generation,
    ],
    [bytes(9), f.purpose, { ...f.generation, nonce: bytes(11, 32) }],
    [bytes(9), f.purpose, { ...f.generation, owner: Principal.anonymous() }],
    [bytes(9), f.purpose, { ...f.generation, key_name: "test_key_1" }],
  ] as [Uint8Array, GrantPurpose, Generation][])
    await f.client.ensureAuthenticated(key, purpose, [generation]);
  expect(f.begin).toHaveBeenCalledTimes(6);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 61000);
  await f.client.ensureAuthenticated(bytes(9), f.purpose, [
    { ...f.generation, key_name: "test_key_1" },
  ]);
  expect(f.begin).toHaveBeenCalledTimes(7);
  f.client.session.lock();
  await f.client.ensureAuthenticated(bytes(9), f.purpose, [
    { ...f.generation, key_name: "test_key_1" },
  ]);
  expect(f.begin).toHaveBeenCalledTimes(8);
  f.client.destroy();
});
it("a known rejection invalidates reuse; an ambiguous mutation blocks new proof and keeps exact retry bytes", async () => {
  const f = fixture();
  await f.client.ensureAuthenticated(bytes(8), f.purpose, [f.generation]);
  f.mutate.mockResolvedValueOnce({ Err: { Unauthorized: null } });
  await expect(f.client.start()).rejects.toThrow("Unauthorized");
  await f.client.ensureAuthenticated(bytes(8), f.purpose, [f.generation]);
  expect(f.begin).toHaveBeenCalledTimes(2);
  f.mutate.mockRejectedValueOnce(Error("network"));
  await expect(f.client.start()).rejects.toThrow("network");
  const uncertain = f.mutate.mock.calls.at(-1);
  await expect(
    f.client.ensureAuthenticated(bytes(8), f.purpose, [f.generation]),
  ).rejects.toThrow("ResolvePendingMutation");
  await expect(
    f.client.authenticate(bytes(8), f.purpose, [f.generation]),
  ).rejects.toThrow("ResolvePendingMutation");
  expect(f.begin).toHaveBeenCalledTimes(2);
  await f.client.retry();
  expect(f.mutate.mock.calls.at(-1)).toEqual(uncertain);
  await f.client.ensureAuthenticated(bytes(8), f.purpose, [f.generation]);
  expect(f.begin).toHaveBeenCalledTimes(2);
  f.client.destroy();
});
it("explicit authentication and final cutover always require fresh proof", async () => {
  const f = fixture();
  await f.client.ensureAuthenticated(bytes(8), f.purpose, [f.generation]);
  await f.client.authenticate(bytes(8), f.purpose, [f.generation]);
  expect(f.begin).toHaveBeenCalledTimes(2);
  f.mutate.mockImplementationOnce(async () => {
    f.complete();
    return { Ok: { Unit: null } };
  });
  await f.client.cutover(bytes(8));
  expect(f.begin).toHaveBeenCalledTimes(3);
  expect(f.begin.mock.calls[2][0].purpose).toEqual({
    IncidentCutover: { job: bytes(3), digest: bytes(7, 32) },
  });
  f.client.destroy();
});
