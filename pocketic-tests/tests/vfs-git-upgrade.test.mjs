import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { IDL } from "@dfinity/candid";
import { PocketIc, PocketIcServer, createIdentity } from "@dfinity/pic";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const fixtureRoot = resolve(repoRoot, "target/pocketic/vfs-git-upgrade");
const v002Wasm = resolve(fixtureRoot, "vfs-v002.wasm");
const v003FailingWasm = resolve(
  fixtureRoot,
  "vfs-v003-migration-failpoint.wasm",
);
const v003Wasm = resolve(fixtureRoot, "vfs-v003.wasm");
const pocketIcBin = process.env.POCKET_IC_BIN;

if (pocketIcBin) {
  PocketIcServer.getBinPath = () => pocketIcBin;
}

const NodeKind = IDL.Variant({ Folder: IDL.Null, File: IDL.Null, Source: IDL.Null });
const NodeMutationError = IDL.Record({ message: IDL.Text });
const NodeMutationAck = IDL.Record({ etag: IDL.Text });
const WriteNodeResult = IDL.Record({ node: NodeMutationAck });
const ResultWrite = IDL.Variant({ Ok: WriteNodeResult, Err: NodeMutationError });
const ResultCreateDatabase = IDL.Variant({
  Ok: IDL.Record({ database_id: IDL.Text }),
  Err: IDL.Text,
});
const ResultReadNode = IDL.Variant({
  Ok: IDL.Opt(IDL.Record({ path: IDL.Text, content: IDL.Text, etag: IDL.Text })),
  Err: IDL.Text,
});
const GitRepositorySnapshot = IDL.Record({
  change_id: IDL.Nat64,
  head_commit_oid: IDL.Text,
  head_ref: IDL.Text,
  object_format: IDL.Text,
});
const ResultGitRepositorySnapshot = IDL.Variant({
  Ok: GitRepositorySnapshot,
  Err: IDL.Text,
});
const GitObjectSummary = IDL.Record({
  oid: IDL.Text,
  size: IDL.Nat64,
  object_type: IDL.Text,
});
const ResultGitObjects = IDL.Variant({
  Ok: IDL.Record({
    objects: IDL.Vec(GitObjectSummary),
    next_cursor: IDL.Opt(IDL.Text),
  }),
  Err: IDL.Text,
});
const GitObjectChunk = IDL.Record({
  oid: IDL.Text,
  data: IDL.Vec(IDL.Nat8),
  size: IDL.Nat64,
  offset: IDL.Nat64,
  next_offset: IDL.Opt(IDL.Nat64),
  object_type: IDL.Text,
});
const ResultGitObjectChunk = IDL.Variant({
  Ok: IDL.Opt(GitObjectChunk),
  Err: IDL.Text,
});
const NodeVersionSummary = IDL.Record({ blob_oid: IDL.Text });
const ResultNodeHistory = IDL.Variant({
  Ok: IDL.Record({
    entries: IDL.Vec(
      IDL.Record({
        commit_oid: IDL.Text,
        before_version: IDL.Opt(NodeVersionSummary),
        after_version: IDL.Opt(NodeVersionSummary),
      }),
    ),
  }),
  Err: IDL.Text,
});

const idlFactory = ({ IDL }) =>
  IDL.Service({
    create_database: IDL.Func(
      [IDL.Record({ name: IDL.Text })],
      [ResultCreateDatabase],
      [],
    ),
    write_node: IDL.Func(
      [
        IDL.Record({
          content: IDL.Text,
          kind: NodeKind,
          path: IDL.Text,
          expected_etag: IDL.Opt(IDL.Text),
          metadata_json: IDL.Text,
          database_id: IDL.Text,
        }),
      ],
      [ResultWrite],
      [],
    ),
    read_node: IDL.Func([IDL.Text, IDL.Text], [ResultReadNode], ["query"]),
    git_repository_snapshot: IDL.Func(
      [IDL.Record({ database_id: IDL.Text })],
      [ResultGitRepositorySnapshot],
      ["query"],
    ),
    list_git_objects: IDL.Func(
      [
        IDL.Record({
          cursor: IDL.Opt(IDL.Text),
          snapshot_change_id: IDL.Nat64,
          limit: IDL.Nat32,
          database_id: IDL.Text,
        }),
      ],
      [ResultGitObjects],
      ["query"],
    ),
    read_git_object_chunk: IDL.Func(
      [
        IDL.Record({
          oid: IDL.Text,
          snapshot_change_id: IDL.Nat64,
          offset: IDL.Nat64,
          limit: IDL.Nat32,
          database_id: IDL.Text,
        }),
      ],
      [ResultGitObjectChunk],
      ["query"],
    ),
    list_node_history: IDL.Func(
      [
        IDL.Record({
          cursor: IDL.Opt(IDL.Nat64),
          limit: IDL.Nat32,
          target: IDL.Variant({ CurrentPath: IDL.Text, PageId: IDL.Nat64 }),
          database_id: IDL.Text,
        }),
      ],
      [ResultNodeHistory],
      ["query"],
    ),
  });

const CyclesTopUpConfig = IDL.Record({
  enabled: IDL.Bool,
  threshold_cycles: IDL.Nat,
  launcher_principal: IDL.Text,
});
const CyclesBillingConfig = IDL.Record({
  billing_authority_id: IDL.Text,
  kinic_ledger_canister_id: IDL.Text,
  top_up: CyclesTopUpConfig,
  cycles_per_kinic: IDL.Nat64,
  min_update_cycles: IDL.Nat64,
});

function ok(result) {
  if ("Err" in result) assert.fail(result.Err);
  assert.deepEqual(Object.keys(result), ["Ok"], String(Object.keys(result)));
  return result.Ok;
}

function writeRequest(databaseId, path, content, expectedEtag = []) {
  return {
    database_id: databaseId,
    path,
    kind: { File: null },
    content,
    metadata_json: "{}",
    expected_etag: expectedEtag,
  };
}

async function exportRepository(actor, databaseId, snapshot) {
  const repository = mkdtempSync(join(tmpdir(), "kinic-git-upgrade-"));
  execFileSync("git", ["init", "--bare", "--object-format=sha1", repository]);
  let cursor = [];
  for (;;) {
    const page = ok(
      await actor.list_git_objects({
        database_id: databaseId,
        snapshot_change_id: snapshot.change_id,
        cursor,
        limit: 100,
      }),
    );
    for (const object of page.objects) {
      const chunks = [];
      let offset = 0n;
      for (;;) {
        const optionalChunk = ok(
          await actor.read_git_object_chunk({
            database_id: databaseId,
            snapshot_change_id: snapshot.change_id,
            oid: object.oid,
            offset,
            limit: 512 * 1024,
          }),
        );
        assert.equal(optionalChunk.length, 1);
        const chunk = optionalChunk[0];
        chunks.push(Buffer.from(chunk.data));
        if (chunk.next_offset.length === 0) break;
        offset = chunk.next_offset[0];
      }
      const oid = execFileSync(
        "git",
        ["--git-dir", repository, "hash-object", "-w", "-t", object.object_type, "--stdin"],
        { input: Buffer.concat(chunks), encoding: "utf8" },
      ).trim();
      assert.equal(oid, object.oid);
    }
    if (page.next_cursor.length === 0) break;
    cursor = page.next_cursor;
  }
  mkdirSync(join(repository, "refs", "heads"), { recursive: true });
  writeFileSync(join(repository, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(
    join(repository, "refs", "heads", "main"),
    `${snapshot.head_commit_oid}\n`,
  );
  return repository;
}

test("v002 Git migration failure rolls back and a normal v003 re-upgrade succeeds", async () => {
  for (const wasm of [v002Wasm, v003FailingWasm, v003Wasm]) {
    assert.equal(existsSync(wasm), true, `missing upgrade fixture ${wasm}`);
  }
  const server = await PocketIcServer.start();
  const pic = await PocketIc.create(server.getUrl());
  const identity = createIdentity("kinic deterministic v002 upgrade owner");
  const principal = identity.getPrincipal();
  const principalText = principal.toText();
  let repository;
  try {
    const initArg = IDL.encode(
      [CyclesBillingConfig],
      [
        {
          billing_authority_id: principalText,
          kinic_ledger_canister_id: principalText,
          top_up: {
            enabled: false,
            threshold_cycles: 1n,
            launcher_principal: principalText,
          },
          cycles_per_kinic: 1n,
          min_update_cycles: 1n,
        },
      ],
    );
    const fixture = await pic.setupCanister({
      sender: principal,
      controllers: [principal],
      arg: initArg,
      idlFactory,
      wasm: v002Wasm,
    });
    let actor = fixture.actor;
    actor.setIdentity(identity);
    const databaseId = ok(await actor.create_database({ name: "upgrade-fixture" }))
      .database_id;
    const initialWrite = ok(
      await actor.write_node(
        writeRequest(databaseId, "/Knowledge/upgrade.md", "before v003"),
      ),
    );

    await assert.rejects(
      pic.upgradeCanister({
        sender: principal,
        canisterId: fixture.canisterId,
        wasm: v003FailingWasm,
      }),
      /migration|trap|Canister/i,
    );
    actor = pic.createActor(idlFactory, fixture.canisterId);
    actor.setIdentity(identity);
    assert.equal(
      ok(await actor.read_node(databaseId, "/Knowledge/upgrade.md"))[0].content,
      "before v003",
    );
    ok(
      await actor.write_node(
        writeRequest(databaseId, "/Knowledge/after-failed-upgrade.md", "v002 remains writable"),
      ),
    );

    await pic.advanceTime(10 * 60 * 1000);
    await pic.tick();
    await pic.upgradeCanister({
      sender: principal,
      canisterId: fixture.canisterId,
      wasm: v003Wasm,
    });
    actor = pic.createActor(idlFactory, fixture.canisterId);
    actor.setIdentity(identity);
    assert.equal(
      ok(await actor.read_node(databaseId, "/Knowledge/after-failed-upgrade.md"))[0]
        .content,
      "v002 remains writable",
    );
    const migrated = ok(
      await actor.git_repository_snapshot({ database_id: databaseId }),
    );
    assert.equal(migrated.change_id, 0n);
    const updated = ok(
      await actor.write_node(
        writeRequest(
          databaseId,
          "/Knowledge/upgrade.md",
          "after v003",
          [initialWrite.node.etag],
        ),
      ),
    );
    assert.notEqual(updated.node.etag, initialWrite.node.etag);
    const snapshot = ok(
      await actor.git_repository_snapshot({ database_id: databaseId }),
    );
    assert.equal(snapshot.change_id, 1n);
    const history = ok(
      await actor.list_node_history({
        database_id: databaseId,
        target: { CurrentPath: "/Knowledge/upgrade.md" },
        cursor: [],
        limit: 10,
      }),
    );
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0].commit_oid, snapshot.head_commit_oid);
    assert.equal(history.entries[0].before_version.length, 1);
    assert.equal(history.entries[0].after_version.length, 1);

    repository = await exportRepository(actor, databaseId, snapshot);
    execFileSync("git", ["--git-dir", repository, "fsck", "--full"]);
    const log = execFileSync(
      "git",
      ["--git-dir", repository, "log", "--format=%H"],
      { encoding: "utf8" },
    );
    assert.match(log, new RegExp(snapshot.head_commit_oid));
    const checkout = mkdtempSync(join(tmpdir(), "kinic-git-checkout-"));
    try {
      execFileSync("git", [
        "--git-dir",
        repository,
        "--work-tree",
        checkout,
        "checkout",
        "HEAD",
        "--",
        ".",
      ]);
      assert.equal(
        readFileSync(join(checkout, "Knowledge", "upgrade.md"), "utf8"),
        "after v003",
      );
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  } finally {
    if (repository) rmSync(repository, { recursive: true, force: true });
    await pic.tearDown();
    await server.stop();
  }
});
