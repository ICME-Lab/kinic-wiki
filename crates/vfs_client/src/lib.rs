// Where: crates/vfs_client/src/lib.rs
// What: Reusable canister client for the VFS public API.
// Why: CLI and non-CLI consumers should share one transport implementation.
use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use candid::{Decode, Encode};
use ic_agent::{
    Agent,
    export::Principal,
    identity::{BasicIdentity, Prime256v1Identity, Secp256k1Identity},
};
use k256::{SecretKey, pkcs8::DecodePrivateKey};
use vfs_types::{
    AppendNodeRequest, CanisterHealth, ChildNode, CreateDatabaseRequest, CreateDatabaseResult,
    CyclesBillingConfig, CyclesPurchaseResult, DatabaseArchiveChunk, DatabaseArchiveInfo,
    DatabaseCycleEntryPage, DatabaseCyclesPendingPurchase, DatabaseCyclesPurchaseRequest,
    DatabaseMember, DatabaseRestoreChunkRequest, DatabaseRole, DatabaseSummary,
    DeleteDatabaseRequest, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest, EditNodeResult,
    ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest, FetchUpdatesResponse,
    GlobNodeHit, GlobNodesRequest, GraphLinksRequest, GraphNeighborhoodRequest,
    IncomingLinksRequest, LinkEdge, ListChildrenRequest, ListNodesRequest,
    MarketCreateListingRequest, MarketEntitlementPage, MarketListing, MarketListingPage,
    MarketOrder, MarketOrderPage, MarketPurchasePreview, MarketPurchaseRequest,
    MarketUpdateListingRequest, MemoryManifest, MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest,
    MoveNodeResult, MultiEditNodeRequest, MultiEditNodeResult, Node, NodeContext,
    NodeContextRequest, NodeEntry, OutgoingLinksRequest, QueryContext, QueryContextRequest,
    RenameDatabaseRequest, SearchNodeHit, SearchNodePathsRequest, SearchNodesRequest,
    SourceEvidence, SourceEvidenceRequest, Status, WriteNodeRequest, WriteNodeResult,
    WriteNodesRequest,
};

#[async_trait]
pub trait VfsApi: Sync {
    fn caller_principal(&self) -> Option<String> {
        None
    }

    async fn status(&self, database_id: &str) -> Result<Status>;
    async fn canister_health(&self) -> Result<CanisterHealth> {
        Err(anyhow!("canister_health is not implemented by this client"))
    }
    async fn memory_manifest(&self) -> Result<MemoryManifest> {
        Err(anyhow!("memory_manifest is not implemented by this client"))
    }
    async fn create_database(&self, _name: &str) -> Result<CreateDatabaseResult> {
        Err(anyhow!("create_database is not implemented by this client"))
    }
    async fn rename_database(&self, _database_id: &str, _name: &str) -> Result<()> {
        Err(anyhow!("rename_database is not implemented by this client"))
    }
    async fn purchase_database_cycles(
        &self,
        _request: DatabaseCyclesPurchaseRequest,
    ) -> Result<CyclesPurchaseResult> {
        Err(anyhow!(
            "purchase_database_cycles is not implemented by this client"
        ))
    }
    async fn check_database_write_cycles(&self, _database_id: &str) -> Result<()> {
        Err(anyhow!(
            "check_database_write_cycles is not implemented by this client"
        ))
    }
    async fn list_database_cycle_entries(
        &self,
        _database_id: &str,
        _cursor: Option<u64>,
        _limit: u32,
    ) -> Result<DatabaseCycleEntryPage> {
        Err(anyhow!(
            "list_database_cycle_entries is not implemented by this client"
        ))
    }
    async fn list_database_cycles_pending_purchases(
        &self,
        _database_id: &str,
    ) -> Result<Vec<DatabaseCyclesPendingPurchase>> {
        Err(anyhow!(
            "list_database_cycles_pending_purchases is not implemented by this client"
        ))
    }
    async fn market_create_listing(
        &self,
        _request: MarketCreateListingRequest,
    ) -> Result<MarketListing> {
        Err(anyhow!(
            "market_create_listing is not implemented by this client"
        ))
    }
    async fn market_update_listing(
        &self,
        _request: MarketUpdateListingRequest,
    ) -> Result<MarketListing> {
        Err(anyhow!(
            "market_update_listing is not implemented by this client"
        ))
    }
    async fn market_publish_listing(&self, _listing_id: &str) -> Result<MarketListing> {
        Err(anyhow!(
            "market_publish_listing is not implemented by this client"
        ))
    }
    async fn market_pause_listing(&self, _listing_id: &str) -> Result<MarketListing> {
        Err(anyhow!(
            "market_pause_listing is not implemented by this client"
        ))
    }
    async fn market_list_listings(
        &self,
        _cursor: Option<String>,
        _limit: u32,
    ) -> Result<MarketListingPage> {
        Err(anyhow!(
            "market_list_listings is not implemented by this client"
        ))
    }
    async fn market_list_database_listings(
        &self,
        _database_id: &str,
    ) -> Result<Vec<MarketListing>> {
        Err(anyhow!(
            "market_list_database_listings is not implemented by this client"
        ))
    }
    async fn market_get_listing(&self, _listing_id: &str) -> Result<MarketListing> {
        Err(anyhow!(
            "market_get_listing is not implemented by this client"
        ))
    }
    async fn market_preview_purchase(&self, _listing_id: &str) -> Result<MarketPurchasePreview> {
        Err(anyhow!(
            "market_preview_purchase is not implemented by this client"
        ))
    }
    async fn market_purchase_access(&self, _request: MarketPurchaseRequest) -> Result<MarketOrder> {
        Err(anyhow!(
            "market_purchase_access is not implemented by this client"
        ))
    }
    async fn market_list_entitlements(
        &self,
        _cursor: Option<String>,
        _limit: u32,
    ) -> Result<MarketEntitlementPage> {
        Err(anyhow!(
            "market_list_entitlements is not implemented by this client"
        ))
    }
    async fn market_list_orders(
        &self,
        _cursor: Option<String>,
        _limit: u32,
    ) -> Result<MarketOrderPage> {
        Err(anyhow!(
            "market_list_orders is not implemented by this client"
        ))
    }
    async fn market_count_active_entitlements(&self, _database_id: &str) -> Result<u64> {
        Err(anyhow!(
            "market_count_active_entitlements is not implemented by this client"
        ))
    }
    async fn get_cycles_billing_config(&self) -> Result<CyclesBillingConfig> {
        Err(anyhow!(
            "get_cycles_billing_config is not implemented by this client"
        ))
    }
    async fn grant_database_access(
        &self,
        _database_id: &str,
        _principal: &str,
        _role: DatabaseRole,
    ) -> Result<()> {
        Err(anyhow!(
            "grant_database_access is not implemented by this client"
        ))
    }
    async fn revoke_database_access(&self, _database_id: &str, _principal: &str) -> Result<()> {
        Err(anyhow!(
            "revoke_database_access is not implemented by this client"
        ))
    }
    async fn list_database_members(&self, _database_id: &str) -> Result<Vec<DatabaseMember>> {
        Err(anyhow!(
            "list_database_members is not implemented by this client"
        ))
    }
    async fn list_databases(&self) -> Result<Vec<DatabaseSummary>> {
        Err(anyhow!("list_databases is not implemented by this client"))
    }
    async fn delete_database(&self, _request: DeleteDatabaseRequest) -> Result<()> {
        Err(anyhow!("delete_database is not implemented by this client"))
    }
    async fn begin_database_archive(&self, _database_id: &str) -> Result<DatabaseArchiveInfo> {
        Err(anyhow!(
            "begin_database_archive is not implemented by this client"
        ))
    }
    async fn read_database_archive_chunk(
        &self,
        _database_id: &str,
        _offset: u64,
        _max_bytes: u32,
    ) -> Result<DatabaseArchiveChunk> {
        Err(anyhow!(
            "read_database_archive_chunk is not implemented by this client"
        ))
    }
    async fn finalize_database_archive(
        &self,
        _database_id: &str,
        _snapshot_hash: Vec<u8>,
    ) -> Result<()> {
        Err(anyhow!(
            "finalize_database_archive is not implemented by this client"
        ))
    }
    async fn cancel_database_archive(&self, _database_id: &str) -> Result<()> {
        Err(anyhow!(
            "cancel_database_archive is not implemented by this client"
        ))
    }
    async fn begin_database_restore(
        &self,
        _database_id: &str,
        _snapshot_hash: Vec<u8>,
        _size_bytes: u64,
    ) -> Result<()> {
        Err(anyhow!(
            "begin_database_restore is not implemented by this client"
        ))
    }
    async fn write_database_restore_chunk(
        &self,
        _request: DatabaseRestoreChunkRequest,
    ) -> Result<()> {
        Err(anyhow!(
            "write_database_restore_chunk is not implemented by this client"
        ))
    }
    async fn finalize_database_restore(&self, _database_id: &str) -> Result<()> {
        Err(anyhow!(
            "finalize_database_restore is not implemented by this client"
        ))
    }
    async fn cancel_database_restore(&self, _database_id: &str) -> Result<()> {
        Err(anyhow!(
            "cancel_database_restore is not implemented by this client"
        ))
    }
    async fn read_node(&self, database_id: &str, path: &str) -> Result<Option<Node>>;
    async fn read_node_context(&self, _request: NodeContextRequest) -> Result<Option<NodeContext>> {
        Err(anyhow!(
            "read_node_context is not implemented by this client"
        ))
    }
    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>>;
    async fn list_children(&self, request: ListChildrenRequest) -> Result<Vec<ChildNode>>;
    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult>;
    async fn write_nodes(&self, _request: WriteNodesRequest) -> Result<Vec<WriteNodeResult>> {
        Err(anyhow!("write_nodes is not implemented by this client"))
    }
    async fn append_node(&self, request: AppendNodeRequest) -> Result<WriteNodeResult>;
    async fn edit_node(&self, request: EditNodeRequest) -> Result<EditNodeResult>;
    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult>;
    async fn move_node(&self, request: MoveNodeRequest) -> Result<MoveNodeResult>;
    async fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult>;
    async fn glob_nodes(&self, request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>>;
    async fn graph_links(&self, _request: GraphLinksRequest) -> Result<Vec<LinkEdge>> {
        Err(anyhow!("graph_links is not implemented by this client"))
    }
    async fn graph_neighborhood(
        &self,
        _request: GraphNeighborhoodRequest,
    ) -> Result<Vec<LinkEdge>> {
        Err(anyhow!(
            "graph_neighborhood is not implemented by this client"
        ))
    }
    async fn incoming_links(&self, _request: IncomingLinksRequest) -> Result<Vec<LinkEdge>> {
        Err(anyhow!("incoming_links is not implemented by this client"))
    }
    async fn outgoing_links(&self, _request: OutgoingLinksRequest) -> Result<Vec<LinkEdge>> {
        Err(anyhow!("outgoing_links is not implemented by this client"))
    }
    async fn multi_edit_node(&self, request: MultiEditNodeRequest) -> Result<MultiEditNodeResult>;
    async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>>;
    async fn query_context(&self, _request: QueryContextRequest) -> Result<QueryContext> {
        Err(anyhow!("query_context is not implemented by this client"))
    }
    async fn source_evidence(&self, _request: SourceEvidenceRequest) -> Result<SourceEvidence> {
        Err(anyhow!("source_evidence is not implemented by this client"))
    }
    async fn search_node_paths(
        &self,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>>;
    async fn export_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse>;
    async fn fetch_updates(&self, request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse>;
}

#[derive(Clone)]
pub struct CanisterVfsClient {
    agent: Agent,
    canister_id: Principal,
    caller_principal: String,
}

impl CanisterVfsClient {
    pub async fn new(replica_host: &str, canister_id: &str) -> Result<Self> {
        let agent = Agent::builder()
            .with_url(replica_host)
            .build()
            .context("failed to build IC agent")?;
        Self::from_agent(replica_host, canister_id, agent, Principal::anonymous()).await
    }

    pub async fn new_with_identity_pem(
        replica_host: &str,
        canister_id: &str,
        identity_pem: &[u8],
    ) -> Result<Self> {
        let identity = identity_from_pem(identity_pem)?;
        Self::new_with_boxed_identity(replica_host, canister_id, identity).await
    }

    pub async fn new_with_boxed_identity(
        replica_host: &str,
        canister_id: &str,
        identity: Box<dyn ic_agent::Identity>,
    ) -> Result<Self> {
        let caller = identity
            .sender()
            .map_err(|error| anyhow!("failed to read identity principal: {error}"))?;
        let agent = Agent::builder()
            .with_url(replica_host)
            .with_boxed_identity(identity)
            .build()
            .context("failed to build IC agent")?;
        Self::from_agent(replica_host, canister_id, agent, caller).await
    }

    async fn from_agent(
        replica_host: &str,
        canister_id: &str,
        agent: Agent,
        caller: Principal,
    ) -> Result<Self> {
        if is_local_replica(replica_host) {
            agent
                .fetch_root_key()
                .await
                .context("failed to fetch local replica root key")?;
        }
        Ok(Self {
            agent,
            canister_id: Principal::from_text(canister_id)
                .context("failed to parse canister principal")?,
            caller_principal: caller.to_text(),
        })
    }

    async fn query<Arg, Out>(&self, method: &str, arg: &Arg) -> Result<Out>
    where
        Arg: candid::CandidType,
        Out: for<'de> candid::Deserialize<'de> + candid::CandidType,
    {
        let bytes = self
            .agent
            .query(&self.canister_id, method)
            .with_arg(Encode!(arg).context("failed to encode query args")?)
            .call()
            .await
            .with_context(|| format!("query failed for {method}"))?;
        Decode!(&bytes, Out)
            .with_context(|| format!("failed to decode query response for {method}"))
    }

    async fn update<Arg, Out>(&self, method: &str, arg: &Arg) -> Result<Out>
    where
        Arg: candid::CandidType,
        Out: for<'de> candid::Deserialize<'de> + candid::CandidType,
    {
        let bytes = self
            .agent
            .update(&self.canister_id, method)
            .with_arg(Encode!(arg).context("failed to encode update args")?)
            .call_and_wait()
            .await
            .with_context(|| format!("update failed for {method}"))?;
        Decode!(&bytes, Out)
            .with_context(|| format!("failed to decode update response for {method}"))
    }

    async fn query2<A, B, Out>(&self, method: &str, a: &A, b: &B) -> Result<Out>
    where
        A: candid::CandidType,
        B: candid::CandidType,
        Out: for<'de> candid::Deserialize<'de> + candid::CandidType,
    {
        let bytes = self
            .agent
            .query(&self.canister_id, method)
            .with_arg(Encode!(a, b).context("failed to encode query args")?)
            .call()
            .await
            .with_context(|| format!("query failed for {method}"))?;
        Decode!(&bytes, Out)
            .with_context(|| format!("failed to decode query response for {method}"))
    }

    async fn update2<A, B, Out>(&self, method: &str, a: &A, b: &B) -> Result<Out>
    where
        A: candid::CandidType,
        B: candid::CandidType,
        Out: for<'de> candid::Deserialize<'de> + candid::CandidType,
    {
        let bytes = self
            .agent
            .update(&self.canister_id, method)
            .with_arg(Encode!(a, b).context("failed to encode update args")?)
            .call_and_wait()
            .await
            .with_context(|| format!("update failed for {method}"))?;
        Decode!(&bytes, Out)
            .with_context(|| format!("failed to decode update response for {method}"))
    }

    async fn update3<A, B, C, Out>(&self, method: &str, a: &A, b: &B, c: &C) -> Result<Out>
    where
        A: candid::CandidType,
        B: candid::CandidType,
        C: candid::CandidType,
        Out: for<'de> candid::Deserialize<'de> + candid::CandidType,
    {
        let bytes = self
            .agent
            .update(&self.canister_id, method)
            .with_arg(Encode!(a, b, c).context("failed to encode update args")?)
            .call_and_wait()
            .await
            .with_context(|| format!("update failed for {method}"))?;
        Decode!(&bytes, Out)
            .with_context(|| format!("failed to decode update response for {method}"))
    }

    async fn query3<A, B, C, Out>(&self, method: &str, a: &A, b: &B, c: &C) -> Result<Out>
    where
        A: candid::CandidType,
        B: candid::CandidType,
        C: candid::CandidType,
        Out: for<'de> candid::Deserialize<'de> + candid::CandidType,
    {
        let bytes = self
            .agent
            .query(&self.canister_id, method)
            .with_arg(Encode!(a, b, c).context("failed to encode query args")?)
            .call()
            .await
            .with_context(|| format!("query failed for {method}"))?;
        Decode!(&bytes, Out)
            .with_context(|| format!("failed to decode query response for {method}"))
    }
}

pub fn identity_from_pem(identity_pem: &[u8]) -> Result<Box<dyn ic_agent::Identity>> {
    if let Ok(identity) = Secp256k1Identity::from_pem(identity_pem) {
        return Ok(Box::new(identity));
    }
    if let Ok(identity) = Prime256v1Identity::from_pem(identity_pem) {
        return Ok(Box::new(identity));
    }
    if let Ok(identity) = BasicIdentity::from_pem(identity_pem) {
        return Ok(Box::new(identity));
    }
    let pem_text = std::str::from_utf8(identity_pem).context("identity PEM is not UTF-8")?;
    let private_key = SecretKey::from_pkcs8_pem(pem_text)
        .context("failed to parse identity PEM as secp256k1 or Ed25519 private key")?;
    Ok(Box::new(Secp256k1Identity::from_private_key(private_key)))
}

#[async_trait]
impl VfsApi for CanisterVfsClient {
    fn caller_principal(&self) -> Option<String> {
        Some(self.caller_principal.clone())
    }

    async fn status(&self, database_id: &str) -> Result<Status> {
        self.query("status", &database_id.to_string()).await
    }

    async fn canister_health(&self) -> Result<CanisterHealth> {
        self.query("canister_health", &()).await
    }

    async fn memory_manifest(&self) -> Result<MemoryManifest> {
        self.query("memory_manifest", &()).await
    }

    async fn create_database(&self, name: &str) -> Result<CreateDatabaseResult> {
        let result: Result<CreateDatabaseResult, String> = self
            .update(
                "create_database",
                &CreateDatabaseRequest {
                    name: name.to_string(),
                },
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn rename_database(&self, database_id: &str, name: &str) -> Result<()> {
        let result: Result<(), String> = self
            .update(
                "rename_database",
                &RenameDatabaseRequest {
                    database_id: database_id.to_string(),
                    name: name.to_string(),
                },
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn purchase_database_cycles(
        &self,
        request: DatabaseCyclesPurchaseRequest,
    ) -> Result<CyclesPurchaseResult> {
        let result: Result<CyclesPurchaseResult, String> =
            self.update("purchase_database_cycles", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn check_database_write_cycles(&self, database_id: &str) -> Result<()> {
        let result: Result<(), String> = self
            .query("check_database_write_cycles", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn list_database_cycle_entries(
        &self,
        database_id: &str,
        cursor: Option<u64>,
        limit: u32,
    ) -> Result<DatabaseCycleEntryPage> {
        let result: Result<DatabaseCycleEntryPage, String> = self
            .query3(
                "list_database_cycle_entries",
                &database_id.to_string(),
                &cursor,
                &limit,
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn get_cycles_billing_config(&self) -> Result<CyclesBillingConfig> {
        let result: Result<CyclesBillingConfig, String> =
            self.query("get_cycles_billing_config", &()).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn list_database_cycles_pending_purchases(
        &self,
        database_id: &str,
    ) -> Result<Vec<DatabaseCyclesPendingPurchase>> {
        let result: Result<Vec<DatabaseCyclesPendingPurchase>, String> = self
            .query(
                "list_database_cycles_pending_purchases",
                &database_id.to_string(),
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_create_listing(
        &self,
        request: MarketCreateListingRequest,
    ) -> Result<MarketListing> {
        let result: Result<MarketListing, String> =
            self.update("market_create_listing", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_update_listing(
        &self,
        request: MarketUpdateListingRequest,
    ) -> Result<MarketListing> {
        let result: Result<MarketListing, String> =
            self.update("market_update_listing", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_publish_listing(&self, listing_id: &str) -> Result<MarketListing> {
        let result: Result<MarketListing, String> = self
            .update("market_publish_listing", &listing_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_pause_listing(&self, listing_id: &str) -> Result<MarketListing> {
        let result: Result<MarketListing, String> = self
            .update("market_pause_listing", &listing_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_list_listings(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketListingPage> {
        let result: Result<MarketListingPage, String> =
            self.query2("market_list_listings", &cursor, &limit).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_list_database_listings(&self, database_id: &str) -> Result<Vec<MarketListing>> {
        let result: Result<Vec<MarketListing>, String> = self
            .query("market_list_database_listings", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_get_listing(&self, listing_id: &str) -> Result<MarketListing> {
        let result: Result<MarketListing, String> = self
            .query("market_get_listing", &listing_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_preview_purchase(&self, listing_id: &str) -> Result<MarketPurchasePreview> {
        let result: Result<MarketPurchasePreview, String> = self
            .query("market_preview_purchase", &listing_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_purchase_access(&self, request: MarketPurchaseRequest) -> Result<MarketOrder> {
        let result: Result<MarketOrder, String> =
            self.update("market_purchase_access", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_list_entitlements(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketEntitlementPage> {
        let result: Result<MarketEntitlementPage, String> = self
            .query2("market_list_entitlements", &cursor, &limit)
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_list_orders(
        &self,
        cursor: Option<String>,
        limit: u32,
    ) -> Result<MarketOrderPage> {
        let result: Result<MarketOrderPage, String> =
            self.query2("market_list_orders", &cursor, &limit).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn market_count_active_entitlements(&self, database_id: &str) -> Result<u64> {
        let result: Result<u64, String> = self
            .query("market_count_active_entitlements", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn grant_database_access(
        &self,
        database_id: &str,
        principal: &str,
        role: DatabaseRole,
    ) -> Result<()> {
        let result: Result<(), String> = self
            .update3(
                "grant_database_access",
                &database_id.to_string(),
                &principal.to_string(),
                &role,
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn revoke_database_access(&self, database_id: &str, principal: &str) -> Result<()> {
        let result: Result<(), String> = self
            .update2(
                "revoke_database_access",
                &database_id.to_string(),
                &principal.to_string(),
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn list_database_members(&self, database_id: &str) -> Result<Vec<DatabaseMember>> {
        let result: Result<Vec<DatabaseMember>, String> = self
            .query("list_database_members", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseSummary>> {
        let result: Result<Vec<DatabaseSummary>, String> =
            self.query("list_databases", &()).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn delete_database(&self, request: DeleteDatabaseRequest) -> Result<()> {
        let result: Result<(), String> = self.update("delete_database", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn begin_database_archive(&self, database_id: &str) -> Result<DatabaseArchiveInfo> {
        let result: Result<DatabaseArchiveInfo, String> = self
            .update("begin_database_archive", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn read_database_archive_chunk(
        &self,
        database_id: &str,
        offset: u64,
        max_bytes: u32,
    ) -> Result<DatabaseArchiveChunk> {
        let result: Result<DatabaseArchiveChunk, String> = self
            .query3(
                "read_database_archive_chunk",
                &database_id.to_string(),
                &offset,
                &max_bytes,
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn finalize_database_archive(
        &self,
        database_id: &str,
        snapshot_hash: Vec<u8>,
    ) -> Result<()> {
        let result: Result<(), String> = self
            .update2(
                "finalize_database_archive",
                &database_id.to_string(),
                &snapshot_hash,
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn cancel_database_archive(&self, database_id: &str) -> Result<()> {
        let result: Result<(), String> = self
            .update("cancel_database_archive", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn begin_database_restore(
        &self,
        database_id: &str,
        snapshot_hash: Vec<u8>,
        size_bytes: u64,
    ) -> Result<()> {
        let result: Result<(), String> = self
            .update3(
                "begin_database_restore",
                &database_id.to_string(),
                &snapshot_hash,
                &size_bytes,
            )
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn write_database_restore_chunk(
        &self,
        request: DatabaseRestoreChunkRequest,
    ) -> Result<()> {
        let result: Result<(), String> = self
            .update("write_database_restore_chunk", &request)
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn finalize_database_restore(&self, database_id: &str) -> Result<()> {
        let result: Result<(), String> = self
            .update("finalize_database_restore", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn cancel_database_restore(&self, database_id: &str) -> Result<()> {
        let result: Result<(), String> = self
            .update("cancel_database_restore", &database_id.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn read_node(&self, database_id: &str, path: &str) -> Result<Option<Node>> {
        let result: Result<Option<Node>, String> = self
            .query2("read_node", &database_id.to_string(), &path.to_string())
            .await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn read_node_context(&self, request: NodeContextRequest) -> Result<Option<NodeContext>> {
        let result: Result<Option<NodeContext>, String> =
            self.query("read_node_context", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        let result: Result<Vec<NodeEntry>, String> = self.query("list_nodes", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn list_children(&self, request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
        let result: Result<Vec<ChildNode>, String> = self.query("list_children", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
        let result: Result<WriteNodeResult, String> = self.update("write_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn write_nodes(&self, request: WriteNodesRequest) -> Result<Vec<WriteNodeResult>> {
        let result: Result<Vec<WriteNodeResult>, String> =
            self.update("write_nodes", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn append_node(&self, request: AppendNodeRequest) -> Result<WriteNodeResult> {
        let result: Result<WriteNodeResult, String> = self.update("append_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn edit_node(&self, request: EditNodeRequest) -> Result<EditNodeResult> {
        let result: Result<EditNodeResult, String> = self.update("edit_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        let result: Result<DeleteNodeResult, String> = self.update("delete_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn move_node(&self, request: MoveNodeRequest) -> Result<MoveNodeResult> {
        let result: Result<MoveNodeResult, String> = self.update("move_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn mkdir_node(&self, request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
        let result: Result<MkdirNodeResult, String> = self.update("mkdir_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn glob_nodes(&self, request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
        let result: Result<Vec<GlobNodeHit>, String> = self.query("glob_nodes", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn graph_links(&self, request: GraphLinksRequest) -> Result<Vec<LinkEdge>> {
        let result: Result<Vec<LinkEdge>, String> = self.query("graph_links", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn graph_neighborhood(&self, request: GraphNeighborhoodRequest) -> Result<Vec<LinkEdge>> {
        let result: Result<Vec<LinkEdge>, String> =
            self.query("graph_neighborhood", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn incoming_links(&self, request: IncomingLinksRequest) -> Result<Vec<LinkEdge>> {
        let result: Result<Vec<LinkEdge>, String> = self.query("incoming_links", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn outgoing_links(&self, request: OutgoingLinksRequest) -> Result<Vec<LinkEdge>> {
        let result: Result<Vec<LinkEdge>, String> = self.query("outgoing_links", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn multi_edit_node(&self, request: MultiEditNodeRequest) -> Result<MultiEditNodeResult> {
        let result: Result<MultiEditNodeResult, String> =
            self.update("multi_edit_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        let result: Result<Vec<SearchNodeHit>, String> =
            self.query("search_nodes", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn query_context(&self, request: QueryContextRequest) -> Result<QueryContext> {
        let result: Result<QueryContext, String> = self.query("query_context", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn source_evidence(&self, request: SourceEvidenceRequest) -> Result<SourceEvidence> {
        let result: Result<SourceEvidence, String> =
            self.query("source_evidence", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn search_node_paths(
        &self,
        request: SearchNodePathsRequest,
    ) -> Result<Vec<SearchNodeHit>> {
        let result: Result<Vec<SearchNodeHit>, String> =
            self.query("search_node_paths", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn export_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse> {
        let result: Result<ExportSnapshotResponse, String> =
            self.query("export_snapshot", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn fetch_updates(&self, request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse> {
        let result: Result<FetchUpdatesResponse, String> =
            self.query("fetch_updates", &request).await?;
        result.map_err(|error| anyhow!(error))
    }
}

fn is_local_replica(host: &str) -> bool {
    host.contains("127.0.0.1") || host.contains("localhost")
}
