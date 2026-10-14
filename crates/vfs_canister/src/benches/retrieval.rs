//! Query-only measurement harness, absent from the production Wasm/interface.
use vfs_types::{SearchNodesForRetrievalRequest, SearchNodesRequest, SearchPreviewMode};

#[derive(candid::CandidType, serde::Serialize)]
struct RetrievalMeasurement {
    instructions: u64,
    response_bytes: u64,
    hits: u32,
}

#[ic_cdk::query]
fn bench_retrieval_search(
    request: SearchNodesForRetrievalRequest,
    retrieval: bool,
) -> Result<RetrievalMeasurement, String> {
    let start = ic_cdk::api::performance_counter(0);
    let (instructions, response_bytes, hits) = if retrieval {
        let result = crate::search_nodes_for_retrieval(request)?;
        let instructions = ic_cdk::api::performance_counter(0) - start;
        (
            instructions,
            candid::encode_one(&result).unwrap().len(),
            result.len(),
        )
    } else {
        let result = crate::search_nodes(SearchNodesRequest {
            database_id: request.database_id,
            query_text: request.query_text,
            prefix: request.prefix,
            top_k: request.top_k,
            preview_mode: Some(SearchPreviewMode::Light),
        })?;
        let instructions = ic_cdk::api::performance_counter(0) - start;
        (
            instructions,
            candid::encode_one(&result).unwrap().len(),
            result.len(),
        )
    };
    Ok(RetrievalMeasurement {
        instructions,
        response_bytes: response_bytes as u64,
        hits: hits as u32,
    })
}
