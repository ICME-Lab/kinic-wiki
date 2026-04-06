// Where: crates/wiki_http_adapter/src/main.rs
// What: CLI entrypoint for the local wiki HTTP companion.
// Why: Obsidian needs a small local process that exposes WikiService over JSON/HTTP.
use std::{env, net::SocketAddr, path::PathBuf};

use tokio::net::TcpListener;
use wiki_http_adapter::app;
use wiki_runtime::WikiService;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args(env::args().skip(1).collect())?;
    let service = WikiService::new(args.database_path.clone());
    service.run_migrations()?;

    let listener = TcpListener::bind(args.bind).await?;
    axum::serve(listener, app(args.database_path)).await?;
    Ok(())
}

struct Args {
    database_path: PathBuf,
    bind: SocketAddr,
}

fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut database_path: Option<PathBuf> = None;
    let mut bind = "127.0.0.1:8787"
        .parse()
        .map_err(|error: std::net::AddrParseError| error.to_string())?;
    let mut index = 0usize;
    while index < args.len() {
        match args[index].as_str() {
            "--db-path" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--db-path requires a value".to_string())?;
                database_path = Some(PathBuf::from(value));
                index += 2;
            }
            "--bind" => {
                let value = args
                    .get(index + 1)
                    .ok_or_else(|| "--bind requires a value".to_string())?;
                bind = value
                    .parse()
                    .map_err(|error: std::net::AddrParseError| error.to_string())?;
                index += 2;
            }
            "--help" | "-h" => return Err(help_text()),
            flag => return Err(format!("unknown argument: {flag}\n\n{}", help_text())),
        }
    }

    Ok(Args {
        database_path: database_path.ok_or_else(help_text)?,
        bind,
    })
}

fn help_text() -> String {
    "usage: cargo run -p wiki-http-adapter -- --db-path <path> [--bind 127.0.0.1:8787]"
        .to_string()
}
