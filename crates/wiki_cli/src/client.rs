// Where: crates/wiki_cli/src/client.rs
// What: Rust canister client for the FS-first CLI.
// Why: The CLI needs direct access to node-based query and update methods.
use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use candid::{Decode, Encode};
use ic_agent::{Agent, export::Principal};
use wiki_types::{
    DeleteNodeRequest, DeleteNodeResult, ExportSnapshotRequest, ExportSnapshotResponse,
    FetchUpdatesRequest, FetchUpdatesResponse, ListNodesRequest, Node, NodeEntry,
    SearchNodeHit, SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
};

#[async_trait]
pub trait WikiApi {
    async fn status(&self) -> Result<Status>;
    async fn read_node(&self, path: &str) -> Result<Option<Node>>;
    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>>;
    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult>;
    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult>;
    async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>>;
    async fn export_snapshot(
        &self,
        request: ExportSnapshotRequest,
    ) -> Result<ExportSnapshotResponse>;
    async fn fetch_updates(&self, request: FetchUpdatesRequest) -> Result<FetchUpdatesResponse>;
}

pub struct CanisterWikiClient {
    agent: Agent,
    canister_id: Principal,
}

impl CanisterWikiClient {
    pub async fn new(replica_host: &str, canister_id: &str) -> Result<Self> {
        let agent = Agent::builder()
            .with_url(replica_host)
            .build()
            .context("failed to build IC agent")?;
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
}

#[async_trait]
impl WikiApi for CanisterWikiClient {
    async fn status(&self) -> Result<Status> {
        self.query("status", &()).await
    }

    async fn read_node(&self, path: &str) -> Result<Option<Node>> {
        let result: Result<Option<Node>, String> = self.query("read_node", &path.to_string()).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn list_nodes(&self, request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
        let result: Result<Vec<NodeEntry>, String> = self.query("list_nodes", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
        let result: Result<WriteNodeResult, String> = self.update("write_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn delete_node(&self, request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
        let result: Result<DeleteNodeResult, String> = self.update("delete_node", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn search_nodes(&self, request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
        let result: Result<Vec<SearchNodeHit>, String> = self.query("search_nodes", &request).await?;
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
