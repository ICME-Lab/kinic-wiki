// Where: crates/wiki_cli/src/bin/beam_dataset_convert.rs
// What: Convert BEAM parquet exports into JSONL rows consumable by the current beam_bench loader.
// Why: The benchmark loader accepts JSON/JSONL only, while full BEAM snapshots are kept as parquet.
use anyhow::{Context, Result, anyhow};
use clap::Parser;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::record::{Field, Row};
use serde_json::Value;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "beam-dataset-convert")]
#[command(about = "Convert a BEAM parquet export into JSONL for beam_bench")]
struct Cli {
    #[arg(long)]
    input_path: PathBuf,
    #[arg(long)]
    output_path: PathBuf,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    convert_parquet_to_jsonl(cli.input_path.as_path(), cli.output_path.as_path())
}

fn convert_parquet_to_jsonl(
    input_path: &std::path::Path,
    output_path: &std::path::Path,
) -> Result<()> {
    let input = File::open(input_path)
        .with_context(|| format!("failed to open parquet input: {}", input_path.display()))?;
    let reader = SerializedFileReader::new(input)
        .with_context(|| format!("failed to open parquet reader: {}", input_path.display()))?;
    let rows = reader
        .get_row_iter(None)
        .with_context(|| "failed to create parquet row iterator")?;

    let output = File::create(output_path)
        .with_context(|| format!("failed to create jsonl output: {}", output_path.display()))?;
    let mut writer = BufWriter::new(output);
    for row in rows {
        let row = row.with_context(|| "failed to read parquet row")?;
        let value = normalize_root_row(&row)?;
        serde_json::to_writer(&mut writer, &value).with_context(|| "failed to encode JSONL row")?;
        writer
            .write_all(b"\n")
            .with_context(|| "failed to write JSONL newline")?;
    }
    writer
        .flush()
        .with_context(|| "failed to flush JSONL output")
}

fn normalize_root_row(row: &Row) -> Result<Value> {
    let mut value = row.to_json_value();
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("parquet root row must convert to a JSON object"))?;
    for (name, field) in row.get_column_iter() {
        object.insert(name.clone(), normalize_named_field(name, field)?);
    }
    normalize_temporal_as_of(object)?;
    Ok(value)
}

fn normalize_named_field(name: &str, field: &Field) -> Result<Value> {
    let value = field_to_json(field)?;
    if matches!(
        name,
        "conversation_seed" | "user_profile" | "user_questions" | "chat"
    ) {
        return maybe_parse_embedded_json(value);
    }
    Ok(value)
}

fn maybe_parse_embedded_json(value: Value) -> Result<Value> {
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.starts_with('{') || trimmed.starts_with('[') {
                serde_json::from_str(trimmed)
                    .or_else(|_| json5::from_str(trimmed))
                    .with_context(|| "failed to parse embedded JSON field")
            } else {
                Ok(Value::String(text))
            }
        }
        other => Ok(other),
    }
}

fn field_to_json(field: &Field) -> Result<Value> {
    Ok(field.to_json_value())
}

fn normalize_temporal_as_of(object: &mut serde_json::Map<String, Value>) -> Result<()> {
    let Some(anchor) = extract_time_anchor(object.get("chat")) else {
        return Ok(());
    };
    let Some(probing_questions) = object.get_mut("probing_questions") else {
        return Ok(());
    };
    let Value::String(literal) = probing_questions else {
        return Ok(());
    };
    let mut parsed: Value = serde_json::from_str(literal)
        .or_else(|_| json5::from_str(literal))
        .with_context(|| "failed to parse probing_questions during parquet conversion")?;
    let Some(items) = parsed
        .as_object_mut()
        .and_then(|root| root.get_mut("temporal_reasoning"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    for item in items {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        if !object.contains_key("as_of") {
            object.insert("as_of".to_string(), Value::String(anchor.clone()));
        }
    }
    *literal = serde_json::to_string(&parsed)
        .with_context(|| "failed to serialize normalized probing_questions")?;
    Ok(())
}

fn extract_time_anchor(chat: Option<&Value>) -> Option<String> {
    let sessions = chat?.as_array()?;
    for session in sessions {
        let messages = session.as_array()?;
        for message in messages {
            let anchor = message
                .as_object()
                .and_then(|object| object.get("time_anchor"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if let Some(anchor) = anchor {
                return Some(anchor.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{
        extract_time_anchor, field_to_json, maybe_parse_embedded_json, normalize_temporal_as_of,
    };
    use parquet::record::Field;
    use serde_json::{Map, Value, json};

    #[test]
    fn parses_embedded_json_strings_for_structured_fields() {
        let value = maybe_parse_embedded_json(serde_json::Value::String("{\"k\":1}".to_string()))
            .expect("embedded JSON should parse");
        assert_eq!(value, json!({"k": 1}));
    }

    #[test]
    fn scalar_fields_convert_to_json() {
        assert_eq!(
            field_to_json(&Field::Str("hello".to_string())).expect("string field should convert"),
            json!("hello")
        );
        assert_eq!(
            field_to_json(&Field::Int(42)).expect("int field should convert"),
            json!(42)
        );
    }

    #[test]
    fn temporal_questions_inherit_time_anchor_when_missing_as_of() {
        let mut object = Map::new();
        object.insert(
            "chat".to_string(),
            json!([[{"time_anchor":"March-15-2024","role":"user","content":"hi"}]]),
        );
        object.insert(
            "probing_questions".to_string(),
            Value::String(
                "{\"temporal_reasoning\":[{\"question\":\"When?\",\"answer\":\"Soon\"}]}"
                    .to_string(),
            ),
        );
        normalize_temporal_as_of(&mut object).expect("temporal normalization should succeed");
        let parsed: Value =
            serde_json::from_str(object["probing_questions"].as_str().expect("string"))
                .expect("normalized probing questions should be JSON");
        assert_eq!(
            parsed["temporal_reasoning"][0]["as_of"],
            json!("March-15-2024")
        );
        assert_eq!(
            extract_time_anchor(object.get("chat")),
            Some("March-15-2024".to_string())
        );
    }
}
