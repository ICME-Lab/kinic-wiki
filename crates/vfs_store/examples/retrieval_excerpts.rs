//! JSON stdin/stdout bridge for cross-language regression evaluation.
#[path = "../src/retrieval_excerpt.rs"]
mod retrieval_excerpt;
fn main() {
    let inputs: Vec<(String, String)> =
        serde_json::from_reader(std::io::stdin()).expect("query/content pairs");
    let output: Vec<String> = inputs
        .iter()
        .map(|(query, content)| retrieval_excerpt::excerpt(query, content))
        .collect();
    serde_json::to_writer(std::io::stdout(), &output).expect("write excerpts");
}
