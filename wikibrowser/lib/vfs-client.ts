import { type Identity } from "@icp-sdk/core/agent";
import { sortChildNodes } from "@/lib/child-sort";
import { normalizeSearchHit } from "@/lib/search-normalizer";
import type { SearchPreviewMode } from "@/lib/search-options";
import type {
  CanisterHealth,
  ChildNode,
  DatabaseMetadata,
  DeleteDatabaseRequest,
  DeleteNodeRequest,
  DeleteNodeResult,
  DatabaseMember,
  DatabaseRole,
  InitialFreeDatabaseGrantStatus,
  LinkEdge,
  UpdateDatabaseMetadataRequest,
  MkdirNodeRequest,
  MkdirNodeResult,
  MoveNodeRequest,
  MoveNodeResult,
  NodePublication,
  NodeContext,
  NodeEntryKind,
  NodeKind,
  QueryContext,
  PublicNode,
  QueryAnswerSessionCheckRequest,
  QueryAnswerSessionCheckResult,
  QueryAnswerSessionRequest,
  RecentNode,
  SearchNodeHit,
  SourceEvidence,
  SourceRunSessionCheckRequest,
  SourceCaptureTriggerSessionCheckRequest,
  SourceCaptureTriggerSessionRequest,
  WikiNode,
  WriteNodeRequest,
  WriteNodeResult,
  WriteNodesRequest,
  WriteSourceForGenerationRequest,
  WriteSourceForGenerationResult
} from "@/lib/types";

export * from "./vfs-client/raw-types";
export * from "./vfs-client/actor";
export * from "./vfs-client/cycles";
export * from "./vfs-client/market";
import type { CreateDatabaseResult, RawCanisterHealth, RawChild, RawDatabaseMember, RawNode, RawNodeContext, RawNodePublication, RawPublicNode, RawQueryAnswerSessionCheckRequest, RawQueryAnswerSessionRequest, RawQueryContext, RawRecent, RawSourceCaptureTriggerSessionCheckRequest, RawSourceCaptureTriggerSessionRequest, RawSourceEvidence, RawSourceRunSessionCheckRequest, RawUpdateDatabaseMetadataRequest, Variant } from "./vfs-client/raw-types";
import { callVfs, createAuthenticatedActor, createReadActor, healthCache, normalizeDatabaseRole, normalizeDatabaseStatus, normalizeLinkEdge, normalizeDatabaseMetadata, rawOptionalText, throwCanisterError, throwNodeMutationError, createVfsActor } from "./vfs-client/actor";
import { normalizeInitialFreeDatabaseGrantStatus } from "./vfs-client/cycles";
export async function readNode(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<WikiNode | null> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.read_node(databaseId, path);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    const raw = result.Ok[0];
    return raw ? normalizeNode(raw) : null;
  });
}

export async function getNodePublication(canisterId: string, databaseId: string, path: string, identity: Identity): Promise<NodePublication | null> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.get_node_publication({ database_id: databaseId, path });
    if ("Err" in result) throwCanisterError(result.Err);
    return result.Ok[0] ? normalizeNodePublication(result.Ok[0]) : null;
  });
}

export async function publishNodeAuthenticated(canisterId: string, databaseId: string, path: string, identity: Identity): Promise<NodePublication> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.publish_node({ database_id: databaseId, path });
    if ("Err" in result) throwCanisterError(result.Err);
    return normalizeNodePublication(result.Ok);
  });
}

export async function unpublishNodeAuthenticated(canisterId: string, databaseId: string, path: string, identity: Identity): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.unpublish_node({ database_id: databaseId, path });
    if ("Err" in result) throwCanisterError(result.Err);
  });
}

export async function readPublicNode(canisterId: string, publicId: string): Promise<PublicNode | null> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.read_public_node(publicId);
    if ("Err" in result) throwCanisterError(result.Err);
    return result.Ok[0] ? normalizePublicNode(result.Ok[0]) : null;
  });
}

function normalizeNodePublication(raw: RawNodePublication): NodePublication {
  return {
    publicId: raw.public_id,
    databaseId: raw.database_id,
    path: raw.path,
    publishedAtMs: raw.published_at_ms.toString()
  };
}

function normalizePublicNode(raw: RawPublicNode): PublicNode {
  return {
    content: raw.content,
    updatedAt: raw.updated_at.toString(),
    publishedAtMs: raw.published_at_ms.toString()
  };
}

export function canisterHealth(canisterId: string): Promise<CanisterHealth> {
  const cached = healthCache.get(canisterId);
  if (cached) {
    return cached;
  }
  const request = callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    return normalizeCanisterHealth(await actor.canister_health());
  }).catch((error) => {
    healthCache.delete(canisterId);
    throw error;
  });
  healthCache.set(canisterId, request);
  return request;
}

export async function createDatabaseAuthenticated(canisterId: string, identity: Identity, name: string): Promise<CreateDatabaseResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.create_database({ name });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return {
      database_id: result.Ok.database_id,
      name: result.Ok.name,
      status: normalizeDatabaseStatus(result.Ok.status),
      initial_free_grant_applied: Boolean(result.Ok.initial_free_grant_applied)
    };
  });
}

export async function getInitialFreeDatabaseGrantStatus(canisterId: string, identity: Identity): Promise<InitialFreeDatabaseGrantStatus> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.get_initial_free_database_grant_status();
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeInitialFreeDatabaseGrantStatus(result.Ok);
  });
}

export async function deleteDatabaseAuthenticated(canisterId: string, identity: Identity, request: DeleteDatabaseRequest): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.delete_database({
      database_id: request.databaseId
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function updateDatabaseMetadataAuthenticated(
  canisterId: string,
  identity: Identity,
  request: UpdateDatabaseMetadataRequest
): Promise<DatabaseMetadata> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.update_database_metadata(rawUpdateDatabaseMetadataRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeDatabaseMetadata(result.Ok);
  });
}

export async function writeNodeAuthenticated(canisterId: string, identity: Identity, request: WriteNodeRequest): Promise<WriteNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.write_node({
      database_id: request.databaseId,
      path: request.path,
      kind: nodeKindVariant(request.kind),
      content: request.content,
      metadata_json: request.metadataJson,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : []
    });
    if ("Err" in result) {
      throwNodeMutationError(result.Err);
    }
    return {
      created: result.Ok.created,
      node: normalizeRecentNode(result.Ok.node)
    };
  });
}

export async function writeNodesAuthenticated(canisterId: string, identity: Identity, request: WriteNodesRequest): Promise<WriteNodeResult[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.write_nodes({
      database_id: request.databaseId,
      nodes: request.nodes.map((node) => ({
        path: node.path,
        kind: nodeKindVariant(node.kind),
        content: node.content,
        metadata_json: node.metadataJson,
        expected_etag: node.expectedEtag ? [node.expectedEtag] : []
      }))
    });
    if ("Err" in result) {
      throwNodeMutationError(result.Err);
    }
    return result.Ok.map((write) => ({ created: write.created, node: normalizeRecentNode(write.node) }));
  });
}

export async function writeSourceForGenerationAuthenticated(
  canisterId: string,
  identity: Identity,
  request: WriteSourceForGenerationRequest
): Promise<WriteSourceForGenerationResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.write_source_for_generation({
      database_id: request.databaseId,
      path: request.path,
      content: request.content,
      metadata_json: request.metadataJson,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : [],
      session_nonce: request.sessionNonce
    });
    if ("Err" in result) {
      throwNodeMutationError(result.Err);
    }
    return {
      write: {
        created: result.Ok.write.created,
        node: normalizeRecentNode(result.Ok.write.node)
      },
      sessionNonce: result.Ok.session_nonce
    };
  });
}

export async function deleteNodeAuthenticated(canisterId: string, identity: Identity, request: DeleteNodeRequest): Promise<DeleteNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.delete_node({
      database_id: request.databaseId,
      path: request.path,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : [],
      expected_folder_index_etag: request.expectedFolderIndexEtag ? [request.expectedFolderIndexEtag] : []
    });
    if ("Err" in result) {
      throwNodeMutationError(result.Err);
    }
    return result.Ok;
  });
}

export async function mkdirNodeAuthenticated(canisterId: string, identity: Identity, request: MkdirNodeRequest): Promise<MkdirNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.mkdir_node({
      database_id: request.databaseId,
      path: request.path
    });
    if ("Err" in result) {
      throwNodeMutationError(result.Err);
    }
    return result.Ok;
  });
}

export async function moveNodeAuthenticated(canisterId: string, identity: Identity, request: MoveNodeRequest): Promise<MoveNodeResult> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.move_node({
      database_id: request.databaseId,
      from_path: request.fromPath,
      to_path: request.toPath,
      expected_etag: request.expectedEtag ? [request.expectedEtag] : [],
      overwrite: request.overwrite
    });
    if ("Err" in result) {
      throwNodeMutationError(result.Err);
    }
    return {
      fromPath: result.Ok.from_path,
      node: normalizeRecentNode(result.Ok.node),
      overwrote: result.Ok.overwrote
    };
  });
}

export async function authorizeSourceCaptureTriggerSession(
  canisterId: string,
  identity: Identity,
  request: SourceCaptureTriggerSessionRequest
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.authorize_source_capture_trigger_session(rawSourceCaptureTriggerSessionRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function checkSourceCaptureTriggerSession(canisterId: string, request: SourceCaptureTriggerSessionCheckRequest): Promise<void> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.check_source_capture_trigger_session(rawSourceCaptureTriggerSessionCheckRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function authorizeQueryAnswerSession(
  canisterId: string,
  identity: Identity,
  request: QueryAnswerSessionRequest
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    // Compatibility note: the canister method is still ops_*; callers should use the query answer wrapper names above.
    const result = await actor.authorize_ops_answer_session(rawQueryAnswerSessionRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function checkQueryAnswerSession(canisterId: string, request: QueryAnswerSessionCheckRequest): Promise<QueryAnswerSessionCheckResult> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    // Compatibility note: the canister method is still ops_*; callers should use the query answer wrapper names above.
    const result = await actor.check_ops_answer_session(rawQueryAnswerSessionCheckRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return {
      principal: result.Ok.principal
    };
  });
}

export async function checkSourceRunSession(canisterId: string, request: SourceRunSessionCheckRequest): Promise<void> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.check_source_run_session(rawSourceRunSessionCheckRequest(request));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function listDatabaseMembersAuthenticated(canisterId: string, identity: Identity, databaseId: string): Promise<DatabaseMember[]> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.list_database_members(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeDatabaseMember);
  });
}

export async function listDatabaseMembersPublic(canisterId: string, databaseId: string): Promise<DatabaseMember[]> {
  return callVfs(async () => {
    const actor = await createVfsActor(canisterId);
    const result = await actor.list_database_members(databaseId);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeDatabaseMember);
  });
}

export async function grantDatabaseAccessAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string,
  principal: string,
  role: DatabaseRole
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.grant_database_access(databaseId, principal, databaseRoleVariant(role));
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function revokeDatabaseAccessAuthenticated(
  canisterId: string,
  identity: Identity,
  databaseId: string,
  principal: string
): Promise<void> {
  return callVfs(async () => {
    const actor = await createAuthenticatedActor(canisterId, identity);
    const result = await actor.revoke_database_access(databaseId, principal);
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
  });
}

export async function readNodeContext(canisterId: string, databaseId: string, path: string, linkLimit: number, identity?: Identity): Promise<NodeContext | null> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.read_node_context({ database_id: databaseId, path, link_limit: linkLimit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    const raw = result.Ok[0];
    return raw ? normalizeNodeContext(raw) : null;
  });
}

export async function listChildren(canisterId: string, databaseId: string, path: string, identity?: Identity): Promise<ChildNode[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.list_children({ database_id: databaseId, path });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return sortChildNodes(result.Ok.map(normalizeChild));
  });
}

export async function incomingLinks(canisterId: string, databaseId: string, path: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.incoming_links({ database_id: databaseId, path, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function outgoingLinks(canisterId: string, databaseId: string, path: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.outgoing_links({ database_id: databaseId, path, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function graphLinks(canisterId: string, databaseId: string, prefix: string, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.graph_links({ database_id: databaseId, prefix, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function graphNeighborhood(canisterId: string, databaseId: string, centerPath: string, depth: number, limit: number, identity?: Identity): Promise<LinkEdge[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.graph_neighborhood({ database_id: databaseId, center_path: centerPath, depth, limit });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeLinkEdge);
  });
}

export async function queryContext(
  canisterId: string,
  databaseId: string,
  task: string,
  budgetTokens: number,
  identity?: Identity,
  namespace?: string
): Promise<QueryContext> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.query_context({
      database_id: databaseId,
      task,
      entities: [],
      namespace: namespace ? [namespace] : [],
      budget_tokens: budgetTokens,
      include_evidence: false,
      depth: 1
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return normalizeQueryContext(result.Ok);
  });
}

export async function searchNodePaths(
  canisterId: string,
  databaseId: string,
  queryText: string,
  limit: number,
  prefix: string | null,
  previewMode: SearchPreviewMode = "content-start",
  identity?: Identity
): Promise<SearchNodeHit[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.search_node_paths({
      database_id: databaseId,
      query_text: queryText,
      prefix: prefix ? [prefix] : [],
      top_k: limit,
      preview_mode: searchPreviewModeArg(previewMode)
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeSearchHit);
  });
}

export async function searchNodes(
  canisterId: string,
  databaseId: string,
  queryText: string,
  limit: number,
  prefix: string | null,
  previewMode: SearchPreviewMode = "light",
  identity?: Identity
): Promise<SearchNodeHit[]> {
  return callVfs(async () => {
    const actor = await createReadActor(canisterId, identity);
    const result = await actor.search_nodes({
      database_id: databaseId,
      query_text: queryText,
      prefix: prefix ? [prefix] : [],
      top_k: limit,
      preview_mode: searchPreviewModeArg(previewMode)
    });
    if ("Err" in result) {
      throwCanisterError(result.Err);
    }
    return result.Ok.map(normalizeSearchHit);
  });
}

function searchPreviewModeArg(mode: SearchPreviewMode): [] | [Variant] {
  if (mode === "none") return [{ None: null }];
  if (mode === "light") return [{ Light: null }];
  if (mode === "content-start") return [{ ContentStart: null }];
  return [];
}

function normalizeNode(raw: RawNode): WikiNode {
  return {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    content: raw.content,
    createdAt: raw.created_at.toString(),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag,
    metadataJson: raw.metadata_json
  };
}

function normalizeCanisterHealth(raw: RawCanisterHealth): CanisterHealth {
  return {
    cyclesBalance: raw.cycles_balance
  };
}







function rawUpdateDatabaseMetadataRequest(request: UpdateDatabaseMetadataRequest): RawUpdateDatabaseMetadataRequest {
  return {
    database_id: request.databaseId,
    name: request.name,
    description: request.description,
    llm_summary: rawOptionalText(request.llmSummary),
    tags_json: request.tagsJson
  };
}

function normalizeDatabaseMember(raw: RawDatabaseMember): DatabaseMember {
  return {
    databaseId: raw.database_id,
    principal: raw.principal,
    role: normalizeDatabaseRole(raw.role),
    createdAtMs: raw.created_at_ms.toString()
  };
}

function normalizeRecentNode(raw: RawRecent): RecentNode {
  return {
    path: raw.path,
    kind: normalizeNodeKind(raw.kind),
    updatedAt: raw.updated_at.toString(),
    etag: raw.etag
  };
}

function normalizeChild(raw: RawChild): ChildNode {
  return {
    path: raw.path,
    name: raw.name,
    kind: normalizeEntryKind(raw.kind),
    updatedAt: raw.updated_at[0]?.toString() ?? null,
    etag: raw.etag[0] ?? null,
    sizeBytes: raw.size_bytes[0]?.toString() ?? null,
    isVirtual: raw.is_virtual,
    hasChildren: raw.has_children,
    isPublished: raw.is_published
  };
}


function normalizeNodeContext(raw: RawNodeContext): NodeContext {
  return {
    node: normalizeNode(raw.node),
    incomingLinks: raw.incoming_links.map(normalizeLinkEdge),
    outgoingLinks: raw.outgoing_links.map(normalizeLinkEdge)
  };
}

function normalizeQueryContext(raw: RawQueryContext): QueryContext {
  return {
    namespace: raw.namespace,
    task: raw.task,
    searchHits: raw.search_hits.map(normalizeSearchHit),
    nodes: raw.nodes.map(normalizeNodeContext),
    graphLinks: raw.graph_links.map(normalizeLinkEdge),
    evidence: raw.evidence.map(normalizeSourceEvidence),
    truncated: raw.truncated
  };
}

function normalizeSourceEvidence(raw: RawSourceEvidence): SourceEvidence {
  return {
    nodePath: raw.node_path,
    refs: raw.refs.map((ref) => ({
      sourcePath: ref.source_path,
      viaPath: ref.via_path,
      rawHref: ref.raw_href,
      linkText: ref.link_text,
      sourceEtag: ref.source_etag[0] ?? null,
      sourceUpdatedAt: ref.source_updated_at[0]?.toString() ?? null,
      sourceContentHash: ref.source_content_hash[0] ?? null
    }))
  };
}

function normalizeNodeKind(kind: Variant): NodeKind {
  if ("Folder" in kind) return "folder";
  return "Source" in kind ? "source" : "file";
}

function normalizeEntryKind(kind: Variant): NodeEntryKind {
  if ("Folder" in kind) {
    return "folder";
  }
  if ("Directory" in kind) {
    return "directory";
  }
  return "Source" in kind ? "source" : "file";
}




function databaseRoleVariant(role: DatabaseRole): Variant {
  if (role === "owner") {
    return { Owner: null };
  }
  if (role === "writer") {
    return { Writer: null };
  }
  return { Reader: null };
}

function nodeKindVariant(kind: NodeKind): Variant {
  if (kind === "folder") return { Folder: null };
  if (kind === "source") return { Source: null };
  return { File: null };
}

function rawSourceCaptureTriggerSessionRequest(request: SourceCaptureTriggerSessionRequest): RawSourceCaptureTriggerSessionRequest {
  return {
    database_id: request.databaseId,
    session_nonce: request.sessionNonce
  };
}
function rawSourceCaptureTriggerSessionCheckRequest(request: SourceCaptureTriggerSessionCheckRequest): RawSourceCaptureTriggerSessionCheckRequest {
  return {
    database_id: request.databaseId,
    request_path: request.requestPath,
    session_nonce: request.sessionNonce
  };
}

function rawQueryAnswerSessionRequest(request: QueryAnswerSessionRequest): RawQueryAnswerSessionRequest {
  return {
    database_id: request.databaseId,
    session_nonce: request.sessionNonce
  };
}

function rawQueryAnswerSessionCheckRequest(request: QueryAnswerSessionCheckRequest): RawQueryAnswerSessionCheckRequest {
  return {
    database_id: request.databaseId,
    session_nonce: request.sessionNonce
  };
}

function rawSourceRunSessionCheckRequest(request: SourceRunSessionCheckRequest): RawSourceRunSessionCheckRequest {
  return {
    database_id: request.databaseId,
    source_path: request.sourcePath,
    source_etag: request.sourceEtag,
    session_nonce: request.sessionNonce
  };
}
