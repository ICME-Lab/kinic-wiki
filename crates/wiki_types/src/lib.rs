// Where: crates/wiki_types/src/lib.rs
// What: Shared wiki domain types and public runtime contracts.
// Why: Keep store and runtime aligned on the source-of-truth model from LLM_WIKI_PLAN.md.
mod health;
mod sync;
mod upload;

use serde::{Deserialize, Serialize};

pub use health::*;
pub use sync::*;
pub use upload::*;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WikiPageType {
    Entity,
    Concept,
    Overview,
    Comparison,
    QueryNote,
    SourceSummary,
}

impl WikiPageType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Entity => "entity",
            Self::Concept => "concept",
            Self::Overview => "overview",
            Self::Comparison => "comparison",
            Self::QueryNote => "query_note",
            Self::SourceSummary => "source_summary",
        }
    }

    pub fn group_label(&self) -> &'static str {
        match self {
            Self::Entity => "Entities",
            Self::Concept => "Concepts",
            Self::Overview => "Overviews",
            Self::Comparison => "Comparisons",
            Self::QueryNote => "Query Notes",
            Self::SourceSummary => "Source Summaries",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "entity" => Some(Self::Entity),
            "concept" => Some(Self::Concept),
            "overview" => Some(Self::Overview),
            "comparison" => Some(Self::Comparison),
            "query_note" => Some(Self::QueryNote),
            "source_summary" => Some(Self::SourceSummary),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiPage {
    pub id: String,
    pub slug: String,
    pub page_type: WikiPageType,
    pub title: String,
    pub current_revision_id: Option<String>,
    pub summary_1line: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiRevision {
    pub id: String,
    pub page_id: String,
    pub revision_no: i64,
    pub markdown: String,
    pub change_reason: String,
    pub author_type: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiSection {
    pub id: String,
    pub page_id: String,
    pub revision_id: String,
    pub section_path: String,
    pub ordinal: i64,
    pub heading: Option<String>,
    pub text: String,
    pub content_hash: String,
    pub is_current: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub source_type: String,
    pub title: Option<String>,
    pub canonical_uri: Option<String>,
    pub sha256: String,
    pub mime_type: Option<String>,
    pub imported_at: i64,
    pub metadata_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceBody {
    pub source_id: String,
    pub body_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemPage {
    pub slug: String,
    pub markdown: String,
    pub updated_at: i64,
    pub etag: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatePageInput {
    pub slug: String,
    pub page_type: WikiPageType,
    pub title: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateSourceInput {
    pub source_type: String,
    pub title: Option<String>,
    pub canonical_uri: Option<String>,
    pub sha256: String,
    pub mime_type: Option<String>,
    pub imported_at: i64,
    pub metadata_json: String,
    pub body_text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitPageRevisionInput {
    pub page_id: String,
    pub expected_current_revision_id: Option<String>,
    pub title: String,
    pub markdown: String,
    pub change_reason: String,
    pub author_type: String,
    pub tags: Vec<String>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitPageRevisionOutput {
    pub revision_id: String,
    pub revision_no: u64,
    pub section_count: u32,
    pub unchanged_section_count: u32,
    pub changed_section_paths: Vec<String>,
    pub removed_section_paths: Vec<String>,
    pub rendered_system_pages: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageSectionView {
    pub section_path: String,
    pub heading: Option<String>,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageBundle {
    pub page_id: String,
    pub slug: String,
    pub title: String,
    pub page_type: String,
    pub current_revision_id: String,
    pub markdown: String,
    pub sections: Vec<PageSectionView>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LogEvent {
    pub event_type: String,
    pub title: String,
    pub body_markdown: String,
    pub related_page_id: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub page_count: u64,
    pub source_count: u64,
    pub system_page_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchRequest {
    pub query_text: String,
    pub page_types: Vec<WikiPageType>,
    pub top_k: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    pub slug: String,
    pub title: String,
    pub page_type: WikiPageType,
    pub section_path: Option<String>,
    pub snippet: String,
    pub score: f32,
    pub match_reasons: Vec<String>,
}
