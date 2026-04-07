// Where: crates/wiki_cli/src/client.rs
// What: Rust canister client for the wiki CLI.
// Why: The CLI needs direct query/update access without routing through the Obsidian plugin.
use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use candid::{Decode, Encode};
use ic_agent::{Agent, export::Principal};
use wiki_types::{
    CommitWikiChangesRequest, CommitWikiChangesResponse, ExportWikiSnapshotRequest,
    ExportWikiSnapshotResponse, FetchWikiUpdatesRequest, FetchWikiUpdatesResponse, PageBundle,
    SearchHit, SearchRequest, Status, SystemPage,
};

#[async_trait]
pub trait WikiApi {
    async fn status(&self) -> Result<Status>;
    async fn search(&self, request: SearchRequest) -> Result<Vec<SearchHit>>;
    async fn get_page(&self, slug: &str) -> Result<Option<PageBundle>>;
    async fn get_system_page(&self, slug: &str) -> Result<Option<SystemPage>>;
    async fn export_wiki_snapshot(
        &self,
        request: ExportWikiSnapshotRequest,
    ) -> Result<ExportWikiSnapshotResponse>;
    async fn fetch_wiki_updates(
        &self,
        request: FetchWikiUpdatesRequest,
    ) -> Result<FetchWikiUpdatesResponse>;
    async fn commit_wiki_changes(
        &self,
        request: CommitWikiChangesRequest,
    ) -> Result<CommitWikiChangesResponse>;
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

    async fn search(&self, request: SearchRequest) -> Result<Vec<SearchHit>> {
        let result: Result<Vec<SearchHit>, String> = self.query("search", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn get_page(&self, slug: &str) -> Result<Option<PageBundle>> {
        let result: Result<Option<PageBundle>, String> =
            self.query("get_page", &slug.to_string()).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn get_system_page(&self, slug: &str) -> Result<Option<SystemPage>> {
        let result: Result<Option<SystemPage>, String> =
            self.query("get_system_page", &slug.to_string()).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn export_wiki_snapshot(
        &self,
        request: ExportWikiSnapshotRequest,
    ) -> Result<ExportWikiSnapshotResponse> {
        let result: Result<ExportWikiSnapshotResponse, String> =
            self.query("export_wiki_snapshot", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn fetch_wiki_updates(
        &self,
        request: FetchWikiUpdatesRequest,
    ) -> Result<FetchWikiUpdatesResponse> {
        let result: Result<FetchWikiUpdatesResponse, String> =
            self.query("fetch_wiki_updates", &request).await?;
        result.map_err(|error| anyhow!(error))
    }

    async fn commit_wiki_changes(
        &self,
        request: CommitWikiChangesRequest,
    ) -> Result<CommitWikiChangesResponse> {
        let result: Result<CommitWikiChangesResponse, String> =
            self.update("commit_wiki_changes", &request).await?;
        result.map_err(|error| anyhow!(error))
    }
}

fn is_local_replica(host: &str) -> bool {
    host.contains("127.0.0.1") || host.contains("localhost")
}
