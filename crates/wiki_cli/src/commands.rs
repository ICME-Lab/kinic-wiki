// Where: crates/wiki_cli/src/commands.rs
// What: Command handlers for remote reads and local mirror sync.
// Why: The CLI should keep subcommand behavior explicit and easy to test.
use crate::adopt::adopt_draft;
use crate::cli::{Cli, Command};
use crate::client::WikiApi;
use crate::generate::{GenerateDraftRequest, GenerateDraftResponse, generate_draft};
use crate::ingest::{IngestSourcesRequest, IngestSourcesResponse, ingest_sources};
use crate::lint::{lint, print_lint_report};
use crate::lint_local::{lint_local, print_local_lint_report};
use crate::mirror::{
    MirrorState, collect_changed_pages, collect_known_pages, load_state, now_millis,
    read_managed_page_markdown, remove_managed_pages_by_id, remove_stale_managed_pages, save_state,
    update_local_revision_metadata, write_conflict_file, write_snapshot_mirror,
};
use crate::query_page::{
    QueryToPageRequest, QueryToPageResponse, print_query_to_page_response, query_to_page,
};
use crate::source_to_draft::{
    SourceToDraftRequest, print_source_to_draft_response, source_to_draft,
};
use anyhow::{Result, anyhow};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use wiki_types::{CommitWikiChangesRequest, PageChangeInput, PageChangeType, SearchRequest};

pub async fn run_command(client: &impl WikiApi, cli: Cli) -> Result<()> {
    match cli.command {
        Command::SourceToDraft {
            vault_path,
            inputs,
            mirror_root,
            persist_sources,
            json,
        } => {
            let response = source_to_draft(
                client,
                SourceToDraftRequest {
                    vault_path,
                    mirror_root,
                    inputs,
                    persist_sources,
                },
            )
            .await?;
            print_source_to_draft_response(&response, json)?;
            if !response.rejected_sources.is_empty() {
                return Err(anyhow!(
                    "source ingestion completed with {} rejected input(s)",
                    response.rejected_sources.len()
                ));
            }
        }
        Command::GenerateDraft {
            vault_path,
            inputs,
            mirror_root,
            mode,
            output,
            json,
        } => {
            let response = generate_draft(
                client,
                GenerateDraftRequest {
                    vault_path,
                    mirror_root,
                    inputs,
                    mode,
                    output,
                },
            )
            .await?;
            print_generate_draft_response(&response, json)?;
        }
        Command::QueryToPage {
            vault_path,
            input,
            title,
            slug,
            page_type,
            mirror_root,
            json,
        } => {
            let response = query_to_page(
                client,
                QueryToPageRequest {
                    vault_path,
                    mirror_root,
                    input,
                    title,
                    slug,
                    page_type: page_type.map(|value| value.to_wiki_page_type()),
                },
            )
            .await?;
            print_query_to_page_response(&response, json)?;
        }
        Command::SearchRemote {
            query_text,
            page_types,
            top_k,
            json,
        } => {
            let hits = client
                .search(SearchRequest {
                    query_text,
                    page_types: page_types
                        .into_iter()
                        .map(|page_type| page_type.to_wiki_page_type())
                        .collect(),
                    top_k,
                })
                .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&hits)?);
            } else {
                for hit in hits {
                    println!("{}\t{}\t{}", hit.slug, hit.title, hit.snippet);
                }
            }
        }
        Command::GetPage { slug, json } => match client.get_page(&slug).await? {
            Some(page) if json => println!("{}", serde_json::to_string_pretty(&page)?),
            Some(page) => println!("{}", page.markdown),
            None => return Err(anyhow!("page not found: {slug}")),
        },
        Command::GetSystemPage { slug, json } => match client.get_system_page(&slug).await? {
            Some(page) if json => println!("{}", serde_json::to_string_pretty(&page)?),
            Some(page) => println!("{}", page.markdown),
            None => return Err(anyhow!("system page not found: {slug}")),
        },
        Command::Lint { json } => {
            let report = lint(client).await?;
            print_lint_report(&report, json)?;
        }
        Command::LintLocal {
            vault_path,
            mirror_root,
            json,
        } => {
            let report = lint_local(&vault_path.join(mirror_root))?;
            print_local_lint_report(&report, json)?;
        }
        Command::Status {
            vault_path,
            mirror_root,
            json,
        } => {
            let remote = client.status().await?;
            let local = vault_path
                .as_deref()
                .map(|vault| read_local_status(&vault.join(&mirror_root)))
                .transpose()?;
            if json {
                println!("{}", serde_json::to_string_pretty(&(remote, local))?);
            } else {
                println!(
                    "remote: pages={} sources={} system={}",
                    remote.page_count, remote.source_count, remote.system_page_count
                );
                if let Some((state, tracked_count)) = local {
                    println!(
                        "local: snapshot_revision={} tracked_pages={} last_synced_at={}",
                        state.snapshot_revision, tracked_count, state.last_synced_at
                    );
                }
            }
        }
        Command::Pull {
            vault_path,
            mirror_root,
        } => {
            pull(client, &vault_path.join(mirror_root)).await?;
        }
        Command::IngestSource { inputs, json } => {
            let response = ingest_sources(client, IngestSourcesRequest { inputs }).await?;
            print_ingest_sources_response(&response, json)?;
            if !response.rejected.is_empty() {
                return Err(anyhow!(
                    "source ingestion completed with {} rejected input(s)",
                    response.rejected.len()
                ));
            }
        }
        Command::AdoptDraft {
            vault_path,
            slug,
            page_type,
            mirror_root,
            json,
        } => {
            let response = adopt_draft(
                client,
                &vault_path.join(mirror_root),
                &slug,
                page_type.map(|value| value.to_wiki_page_type()),
            )
            .await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&response)?);
            } else {
                println!(
                    "adopted {} -> {} ({})",
                    response.slug,
                    response.path.display(),
                    response.action
                );
            }
        }
        Command::Push {
            vault_path,
            mirror_root,
        } => {
            push(client, &vault_path.join(mirror_root)).await?;
        }
    }
    Ok(())
}

fn print_generate_draft_response(response: &GenerateDraftResponse, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(response)?);
        return Ok(());
    }

    println!("page map:");
    for entry in &response.page_map {
        println!(
            "- {} ({}) [{}]",
            entry.slug,
            entry.title,
            entry.page_type.as_str()
        );
    }
    println!("draft results:");
    for result in &response.draft_results {
        println!(
            "- {} -> {} ({})",
            result.slug,
            result.path.display(),
            result.action
        );
    }
    if response.open_questions.is_empty() {
        println!("open questions: none");
    } else {
        println!("open questions:");
        for question in &response.open_questions {
            println!("- {question}");
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn _keep_query_to_page_response(_response: &QueryToPageResponse) {}

fn print_ingest_sources_response(response: &IngestSourcesResponse, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(response)?);
        return Ok(());
    }

    println!("ingested:");
    for entry in &response.ingested {
        println!(
            "- {} -> {} ({})",
            entry.input_path.display(),
            entry.source_id,
            entry.action
        );
    }
    if response.rejected.is_empty() {
        println!("rejected: none");
    } else {
        println!("rejected:");
        for entry in &response.rejected {
            println!("- {} ({})", entry.input_path.display(), entry.reason);
        }
    }
    Ok(())
}

pub async fn pull(client: &impl WikiApi, mirror_root: &Path) -> Result<()> {
    let state = load_state(mirror_root)?;
    if state.snapshot_revision.is_empty() {
        let snapshot = client
            .export_wiki_snapshot(wiki_types::ExportWikiSnapshotRequest {
                include_system_pages: true,
                page_slugs: None,
            })
            .await?;
        write_snapshot_mirror(mirror_root, &snapshot.pages, &snapshot.system_pages)?;
        remove_stale_managed_pages(
            mirror_root,
            &snapshot
                .pages
                .iter()
                .map(|page| page.page_id.clone())
                .collect::<HashSet<_>>(),
        )?;
        save_state(
            mirror_root,
            &MirrorState {
                snapshot_revision: snapshot.snapshot_revision,
                last_synced_at: now_millis(),
            },
        )?;
        println!("pull complete: {} pages", snapshot.pages.len());
        return Ok(());
    }

    let updates = client
        .fetch_wiki_updates(wiki_types::FetchWikiUpdatesRequest {
            known_snapshot_revision: state.snapshot_revision.clone(),
            known_page_revisions: collect_known_pages(mirror_root)?,
            include_system_pages: true,
        })
        .await?;
    let known_slugs = collect_known_pages(mirror_root)?
        .into_iter()
        .map(|entry| entry.page_id)
        .collect::<HashSet<_>>();
    let _ = known_slugs;
    write_snapshot_mirror(mirror_root, &updates.changed_pages, &updates.system_pages)?;
    remove_managed_pages_by_id(mirror_root, &updates.removed_page_ids)?;
    save_state(
        mirror_root,
        &MirrorState {
            snapshot_revision: updates.snapshot_revision,
            last_synced_at: now_millis(),
        },
    )?;
    println!(
        "pull complete: {} changed, {} removed",
        updates.changed_pages.len(),
        updates.removed_page_ids.len()
    );
    Ok(())
}

pub async fn push(client: &impl WikiApi, mirror_root: &Path) -> Result<()> {
    let state = load_state(mirror_root)?;
    if state.snapshot_revision.is_empty() {
        return Err(anyhow!("mirror state is missing; run pull first"));
    }
    let changed_pages = collect_changed_pages(mirror_root, state.last_synced_at)?;
    if changed_pages.is_empty() {
        println!("push skipped: no changed wiki pages");
        return Ok(());
    }
    let mut payloads = HashMap::<String, String>::new();
    let mut page_changes = Vec::new();
    for page in &changed_pages {
        page_changes.push(PageChangeInput {
            change_type: PageChangeType::Update,
            page_id: page.metadata.page_id.clone(),
            base_revision_id: page.metadata.revision_id.clone(),
            new_markdown: Some(read_managed_page_markdown(page)?),
        });
        payloads.insert(page.metadata.page_id.clone(), page.metadata.slug.clone());
    }
    let response = client
        .commit_wiki_changes(CommitWikiChangesRequest {
            base_snapshot_revision: state.snapshot_revision,
            page_changes,
        })
        .await?;
    for entry in &response.manifest_delta.upserted_pages {
        update_local_revision_metadata(
            mirror_root,
            &entry.page_id,
            &entry.revision_id,
            entry.updated_at,
        )?;
    }
    remove_managed_pages_by_id(mirror_root, &response.manifest_delta.removed_page_ids)?;
    write_snapshot_mirror(mirror_root, &[], &response.system_pages)?;
    for rejected in &response.rejected_pages {
        if let Some(conflict) = &rejected.conflict_markdown {
            let slug = payloads
                .get(&rejected.page_id)
                .cloned()
                .unwrap_or_else(|| rejected.page_id.clone());
            write_conflict_file(mirror_root, &slug, conflict)?;
        }
    }
    save_state(
        mirror_root,
        &MirrorState {
            snapshot_revision: response.snapshot_revision,
            last_synced_at: now_millis(),
        },
    )?;
    println!(
        "push complete: {} committed, {} rejected",
        response.committed_pages.len(),
        response.rejected_pages.len()
    );
    Ok(())
}

fn read_local_status(mirror_root: &Path) -> Result<(MirrorState, usize)> {
    let state = load_state(mirror_root)?;
    let tracked_count = collect_known_pages(mirror_root)?.len();
    Ok((state, tracked_count))
}
