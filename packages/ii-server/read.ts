import { Actor, HttpAgent, type Identity } from "@icp-sdk/core/agent";
type Result<T> = { Ok: T } | { Err: string };
export type WikiReadNode = {
  path: string;
  content: string;
  etag: string;
  metadata_json: string;
  updated_at: bigint;
};
export type ReadActor = {
  read_node(db: string, path: string): Promise<Result<[] | [WikiReadNode]>>;
  memory_manifest(input: {
    database_id: string;
  }): Promise<
    Result<{
      api_version: string;
      recommended_entrypoint: string;
      roots: { path: string; kind: string }[];
    }>
  >;
  query_context(request: {
    database_id: string;
    task: string;
    entities: string[];
    namespace: [string];
    budget_tokens: number;
    include_evidence: boolean;
    depth: number;
  }): Promise<Result<{ nodes: { node: WikiReadNode }[]; truncated: boolean }>>;
  source_evidence(request: {
    database_id: string;
    node_path: string;
  }): Promise<
    Result<{
      node_path: string;
      refs: {
        source_path: string;
        source_etag: [] | [string];
        source_updated_at: [] | [bigint];
      }[];
    }>
  >;
};

/** Common authenticated read invocation. Preserve each caller's full node type. */
export function readNodeRaw<T>(
  actor: { read_node(db: string, path: string): Promise<T> },
  databaseId: string,
  path: string,
): Promise<T> {
  return actor.read_node(databaseId, path);
}

/** Candid record projections intentionally decode only fields used by the assistant.
 * No mutable methods are present on this actor. The canister still enforces caller access.
 */
export const readIdlFactory: Parameters<typeof Actor.createActor>[0] = ({
  IDL: idl,
}) => {
  const Node = idl.Record({
    path: idl.Text,
    content: idl.Text,
    etag: idl.Text,
    metadata_json: idl.Text,
    updated_at: idl.Int64,
  });
  const SourceRef = idl.Record({
    source_path: idl.Text,
    source_etag: idl.Opt(idl.Text),
    source_updated_at: idl.Opt(idl.Int64),
  });
  const Evidence = idl.Record({
    node_path: idl.Text,
    refs: idl.Vec(SourceRef),
  });
  const Manifest = idl.Record({
    api_version: idl.Text,
    recommended_entrypoint: idl.Text,
    roots: idl.Vec(idl.Record({ path: idl.Text, kind: idl.Text })),
  });
  const Context = idl.Record({
    nodes: idl.Vec(idl.Record({ node: Node })),
    truncated: idl.Bool,
  });
  const Query = idl.Record({
    database_id: idl.Text,
    task: idl.Text,
    entities: idl.Vec(idl.Text),
    namespace: idl.Opt(idl.Text),
    budget_tokens: idl.Nat32,
    include_evidence: idl.Bool,
    depth: idl.Nat32,
  });
  return idl.Service({
    read_node: idl.Func(
      [idl.Text, idl.Text],
      [idl.Variant({ Ok: idl.Opt(Node), Err: idl.Text })],
      ["query"],
    ),
    memory_manifest: idl.Func(
      [idl.Record({ database_id: idl.Text })],
      [idl.Variant({ Ok: Manifest, Err: idl.Text })],
      ["query"],
    ),
    query_context: idl.Func(
      [Query],
      [idl.Variant({ Ok: Context, Err: idl.Text })],
      ["query"],
    ),
    source_evidence: idl.Func(
      [idl.Record({ database_id: idl.Text, node_path: idl.Text })],
      [idl.Variant({ Ok: Evidence, Err: idl.Text })],
      ["query"],
    ),
  });
};
export function createReadActor(
  canisterId: string,
  identity: Identity,
): ReadActor {
  return Actor.createActor<ReadActor>(readIdlFactory, {
    agent: HttpAgent.createSync({ host: "https://icp0.io", identity }),
    canisterId,
  });
}
