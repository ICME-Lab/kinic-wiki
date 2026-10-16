use serde::Deserialize;
use std::collections::BTreeMap;
use std::fmt::Write;

#[derive(Deserialize)]
struct Guidance {
    shared: BTreeMap<String, String>,
    methods: Vec<Method>,
    sections: Vec<Section>,
}

#[derive(Deserialize)]
struct Method {
    mcp: String,
    canister: String,
    usage: String,
}

#[derive(Deserialize)]
struct Section {
    title: String,
    text: String,
}

pub(super) fn render() -> String {
    // The MCP Worker imports this same source. No identity, database or I/O is needed.
    // Share API semantics here; keep MCP transport, OAuth and tool-only limits in the Worker.
    let guidance: Guidance = serde_json::from_str(include_str!(
        "../../../packages/vfs-client-core/api-guidance.json"
    ))
    .expect("embedded API guidance must be valid JSON");
    let mut doc = String::from(
        "# Kinic Wiki API\n\nUse the published Candid interface for exact types. This guide describes existing behavior.\n\n## Existing MCP / canister API mapping\n\n| MCP tool | Canister method | Direct usage |\n| --- | --- | --- |\n",
    );
    for method in guidance.methods {
        writeln!(
            doc,
            "| {} | `{}` | {} |",
            method.mcp, method.canister, method.usage
        )
        .expect("writing to a String cannot fail");
    }
    for section in guidance.sections {
        writeln!(doc, "\n## {}\n\n{}", section.title, section.text)
            .expect("writing to a String cannot fail");
    }
    doc.push_str("\n## Shared reading and mutation guidance\n\nThese rules also guide the existing MCP tools. Retry advice is guidance, not an automatic canister retry policy.\n\n");
    for text in guidance.shared.values() {
        writeln!(doc, "- {text}").expect("writing to a String cannot fail");
    }
    doc
}
