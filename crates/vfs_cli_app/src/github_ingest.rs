// Where: crates/vfs_cli_app/src/github_ingest.rs
// What: GitHub issue and pull-request evidence ingestion into VFS sources.
// Why: GitHub review context is evidence; skill registry packages remain separate.
use crate::cli::{GitHubCommand, GitHubIngestCommand};
use crate::github_source::{classify_gh_command_failure, ensure_gh_ready};
use anyhow::{Result, anyhow};
use serde::Deserialize;
use std::process::Stdio;
use tokio::process::Command;
use vfs_client::VfsApi;
use vfs_types::{NodeKind, WriteNodeRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubTarget {
    pub owner: String,
    pub repo: String,
    pub number: u64,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueView {
    number: u64,
    title: String,
    state: String,
    url: String,
    author: Option<GitHubUser>,
    body: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullView {
    number: u64,
    title: String,
    state: String,
    url: String,
    author: Option<GitHubUser>,
    body: Option<String>,
    created_at: String,
    updated_at: String,
    base_ref_name: String,
    head_ref_name: String,
}

pub async fn run_github_command(
    client: &impl VfsApi,
    database_id: &str,
    command: GitHubCommand,
) -> Result<()> {
    ensure_gh_ready().await?;
    match command {
        GitHubCommand::Ingest { command } => match command {
            GitHubIngestCommand::Issue { target, json } => {
                let target = parse_github_target(&target)?;
                let content = fetch_issue_markdown(&target).await?;
                let path = github_evidence_path(&target, "issues");
                write_source_node(client, database_id, &path, content).await?;
                print_result(json, &path)?;
            }
            GitHubIngestCommand::Pr { target, json } => {
                let target = parse_github_target(&target)?;
                let content = fetch_pull_markdown(&target).await?;
                let path = github_evidence_path(&target, "pulls");
                write_source_node(client, database_id, &path, content).await?;
                print_result(json, &path)?;
            }
        },
    }
    Ok(())
}

pub fn parse_github_target(input: &str) -> Result<GitHubTarget> {
    let (repo_part, number_part) = input
        .split_once('#')
        .ok_or_else(|| anyhow!("GitHub target must use owner/repo#number"))?;
    let mut segments = repo_part.split('/');
    let owner = segments.next().unwrap_or_default();
    let repo = segments.next().unwrap_or_default();
    if segments.next().is_some() || !valid_segment(owner) || !valid_segment(repo) {
        return Err(anyhow!("GitHub target must use owner/repo#number"));
    }
    let number = number_part
        .parse::<u64>()
        .map_err(|_| anyhow!("GitHub target number must be numeric"))?;
    if number == 0 {
        return Err(anyhow!("GitHub target number must be positive"));
    }
    Ok(GitHubTarget {
        owner: owner.to_string(),
        repo: repo.to_string(),
        number,
    })
}

fn github_evidence_path(target: &GitHubTarget, kind: &str) -> String {
    format!(
        "/Sources/github/{}/{}/{}/{}.md",
        target.owner, target.repo, kind, target.number
    )
}

async fn fetch_issue_markdown(target: &GitHubTarget) -> Result<String> {
    let output = gh_view(
        "issue",
        target,
        "number,title,state,url,author,body,createdAt,updatedAt",
    )
    .await?;
    let issue: IssueView = serde_json::from_slice(&output)
        .map_err(|error| anyhow!("gh issue view response invalid: {error}"))?;
    Ok(format_issue_markdown(target, &issue))
}

async fn fetch_pull_markdown(target: &GitHubTarget) -> Result<String> {
    let output = gh_view(
        "pr",
        target,
        "number,title,state,url,author,body,createdAt,updatedAt,baseRefName,headRefName",
    )
    .await?;
    let pull: PullView = serde_json::from_slice(&output)
        .map_err(|error| anyhow!("gh pr view response invalid: {error}"))?;
    Ok(format_pull_markdown(target, &pull))
}

async fn gh_view(kind: &str, target: &GitHubTarget, fields: &str) -> Result<Vec<u8>> {
    let repo = format!("{}/{}", target.owner, target.repo);
    let number = target.number.to_string();
    let output = Command::new("gh")
        .args([kind, "view", &number, "--repo", &repo, "--json", fields])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| anyhow!("failed to run gh: {error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(anyhow!(
        "{}",
        classify_gh_command_failure(
            &format!("fetch GitHub {kind}"),
            &format!("{repo}#{number}"),
            &String::from_utf8_lossy(&output.stderr)
        )
    ))
}

async fn write_source_node(
    client: &impl VfsApi,
    database_id: &str,
    path: &str,
    content: String,
) -> Result<()> {
    let expected_etag = client
        .read_node(database_id, path)
        .await?
        .map(|node| node.etag);
    client
        .write_node(WriteNodeRequest {
            database_id: database_id.to_string(),
            path: path.to_string(),
            kind: NodeKind::Source,
            content,
            metadata_json: "{}".to_string(),
            expected_etag,
        })
        .await?;
    Ok(())
}

fn format_issue_markdown(target: &GitHubTarget, issue: &IssueView) -> String {
    format!(
        "---\nsource: github\nkind: issue\nrepo: {}/{}\nnumber: {}\nurl: {}\nstate: {}\ncreated_at: {}\nupdated_at: {}\n---\n# {} #{}\n\n- Author: {}\n- URL: {}\n\n{}\n",
        target.owner,
        target.repo,
        issue.number,
        issue.url,
        issue.state,
        issue.created_at,
        issue.updated_at,
        issue.title,
        issue.number,
        issue
            .author
            .as_ref()
            .map(|author| author.login.as_str())
            .unwrap_or("unknown"),
        issue.url,
        issue.body.as_deref().unwrap_or("")
    )
}

fn format_pull_markdown(target: &GitHubTarget, pull: &PullView) -> String {
    format!(
        "---\nsource: github\nkind: pull_request\nrepo: {}/{}\nnumber: {}\nurl: {}\nstate: {}\ncreated_at: {}\nupdated_at: {}\nbase_ref: {}\nhead_ref: {}\n---\n# {} #{}\n\n- Author: {}\n- URL: {}\n- Base: {}\n- Head: {}\n\n{}\n",
        target.owner,
        target.repo,
        pull.number,
        pull.url,
        pull.state,
        pull.created_at,
        pull.updated_at,
        pull.base_ref_name,
        pull.head_ref_name,
        pull.title,
        pull.number,
        pull.author
            .as_ref()
            .map(|author| author.login.as_str())
            .unwrap_or("unknown"),
        pull.url,
        pull.base_ref_name,
        pull.head_ref_name,
        pull.body.as_deref().unwrap_or("")
    )
}

fn print_result(json: bool, path: &str) -> Result<()> {
    if json {
        println!("{}", serde_json::json!({ "path": path }));
    } else {
        println!("github evidence imported: {path}");
    }
    Ok(())
}

fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
}

#[cfg(test)]
mod tests {
    use super::{GitHubTarget, parse_github_target, write_source_node};
    use anyhow::Result;
    use async_trait::async_trait;
    use std::sync::Mutex;
    use vfs_client::VfsApi;
    use vfs_types::{
        AppendNodeRequest, ChildNode, DeleteNodeRequest, DeleteNodeResult, EditNodeRequest,
        EditNodeResult, ExportSnapshotRequest, ExportSnapshotResponse, FetchUpdatesRequest,
        FetchUpdatesResponse, GlobNodeHit, GlobNodesRequest, ListChildrenRequest, ListNodesRequest,
        MkdirNodeRequest, MkdirNodeResult, MoveNodeRequest, MoveNodeResult, MultiEditNodeRequest,
        MultiEditNodeResult, Node, NodeEntry, NodeKind, NodeMutationAck, SearchNodeHit,
        SearchNodePathsRequest, SearchNodesRequest, Status, WriteNodeRequest, WriteNodeResult,
    };

    #[test]
    fn parses_github_targets() {
        assert_eq!(
            parse_github_target("owner/repo#123").expect("target should parse"),
            GitHubTarget {
                owner: "owner".to_string(),
                repo: "repo".to_string(),
                number: 123,
            }
        );
    }

    #[test]
    fn rejects_invalid_targets() {
        assert!(parse_github_target("owner/repo").is_err());
        assert!(parse_github_target("owner/repo#abc").is_err());
        assert!(parse_github_target("owner/repo#0").is_err());
    }

    #[tokio::test]
    async fn write_source_node_uses_existing_etag_when_present() {
        let client = GitHubIngestMockClient::with_existing(sample_node("etag-current"));

        write_source_node(
            &client,
            "default",
            "/Sources/github/owner/repo/issues/1.md",
            "content".to_string(),
        )
        .await
        .expect("source write should succeed");

        let request = client.take_write_request();
        assert_eq!(request.expected_etag, Some("etag-current".to_string()));
        assert_eq!(request.kind, NodeKind::Source);
    }

    #[tokio::test]
    async fn write_source_node_uses_none_for_new_node() {
        let client = GitHubIngestMockClient::default();

        write_source_node(
            &client,
            "default",
            "/Sources/github/owner/repo/pulls/1.md",
            "content".to_string(),
        )
        .await
        .expect("source write should succeed");

        let request = client.take_write_request();
        assert_eq!(request.expected_etag, None);
        assert_eq!(request.kind, NodeKind::Source);
    }

    #[derive(Default)]
    struct GitHubIngestMockClient {
        existing: Option<Node>,
        write_request: Mutex<Option<WriteNodeRequest>>,
    }

    impl GitHubIngestMockClient {
        fn with_existing(existing: Node) -> Self {
            Self {
                existing: Some(existing),
                write_request: Mutex::new(None),
            }
        }

        fn take_write_request(&self) -> WriteNodeRequest {
            self.write_request
                .lock()
                .expect("write request lock should succeed")
                .take()
                .expect("write request should be recorded")
        }
    }

    #[async_trait]
    impl VfsApi for GitHubIngestMockClient {
        async fn status(&self, _database_id: &str) -> Result<Status> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn read_node(&self, _database_id: &str, _path: &str) -> Result<Option<Node>> {
            Ok(self.existing.clone())
        }

        async fn list_nodes(&self, _request: ListNodesRequest) -> Result<Vec<NodeEntry>> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn list_children(&self, _request: ListChildrenRequest) -> Result<Vec<ChildNode>> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn write_node(&self, request: WriteNodeRequest) -> Result<WriteNodeResult> {
            *self
                .write_request
                .lock()
                .expect("write request lock should succeed") = Some(request.clone());
            Ok(WriteNodeResult {
                created: request.expected_etag.is_none(),
                node: NodeMutationAck {
                    path: request.path,
                    kind: request.kind,
                    updated_at: 1,
                    etag: "etag-write".to_string(),
                },
            })
        }

        async fn append_node(&self, _request: AppendNodeRequest) -> Result<WriteNodeResult> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn edit_node(&self, _request: EditNodeRequest) -> Result<EditNodeResult> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn delete_node(&self, _request: DeleteNodeRequest) -> Result<DeleteNodeResult> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn move_node(&self, _request: MoveNodeRequest) -> Result<MoveNodeResult> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn mkdir_node(&self, _request: MkdirNodeRequest) -> Result<MkdirNodeResult> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn glob_nodes(&self, _request: GlobNodesRequest) -> Result<Vec<GlobNodeHit>> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn multi_edit_node(
            &self,
            _request: MultiEditNodeRequest,
        ) -> Result<MultiEditNodeResult> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn search_nodes(&self, _request: SearchNodesRequest) -> Result<Vec<SearchNodeHit>> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn search_node_paths(
            &self,
            _request: SearchNodePathsRequest,
        ) -> Result<Vec<SearchNodeHit>> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn export_snapshot(
            &self,
            _request: ExportSnapshotRequest,
        ) -> Result<ExportSnapshotResponse> {
            unimplemented!("not needed by github ingest tests")
        }

        async fn fetch_updates(
            &self,
            _request: FetchUpdatesRequest,
        ) -> Result<FetchUpdatesResponse> {
            unimplemented!("not needed by github ingest tests")
        }
    }

    fn sample_node(etag: &str) -> Node {
        Node {
            path: "/Sources/github/owner/repo/issues/1.md".to_string(),
            kind: NodeKind::Source,
            content: "old".to_string(),
            created_at: 1,
            updated_at: 1,
            etag: etag.to_string(),
            metadata_json: "{}".to_string(),
        }
    }
}
