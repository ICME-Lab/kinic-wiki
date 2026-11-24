use std::{
    env, fs,
    path::{Path, PathBuf},
};
fn walk(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("build vaultbrowser before Wasm") {
        let p = entry.unwrap().path();
        if p.is_dir() {
            walk(&p, root, out)
        } else {
            out.push(p.strip_prefix(root).unwrap().into())
        }
    }
}
fn loopback_origin(origin: &str) -> bool {
    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    let default_port = match scheme {
        "http" => 80,
        "https" => 443,
        _ => return false,
    };
    let (host, port) = if let Some(port) = authority.strip_prefix("[::1]") {
        ("[::1]", (!port.is_empty()).then_some(port))
    } else if let Some((host, _)) = authority.split_once(':') {
        (host, Some(&authority[host.len()..]))
    } else {
        (authority, None)
    };
    if !(matches!(host, "localhost" | "127.0.0.1" | "[::1]")
        || host.ends_with(".localhost")
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            }))
    {
        return false;
    }
    port.is_none_or(|port| {
        port.strip_prefix(':').is_some_and(|digits| {
            digits
                .parse::<u16>()
                .is_ok_and(|n| n != 0 && n != default_port && n.to_string() == digits)
        })
    })
}

fn main() {
    let root =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../vaultbrowser/dist");
    println!("cargo:rerun-if-changed={}", root.display());
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_NATIVE_CALLBACK");
    if env::var_os("VAULT_LOCAL_NATIVE_CALLBACK").is_some() {
        assert!(
            env::var_os("VAULT_LOCAL_ORIGIN").is_some(),
            "Native local callbacks require VAULT_LOCAL_ORIGIN"
        );
    }
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_ORIGIN");
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_HOST");
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_II");
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_WIKI_ORIGIN");
    if let Some(wiki) = env::var_os("VAULT_LOCAL_WIKI_ORIGIN") {
        let vault = env::var("VAULT_LOCAL_ORIGIN")
            .expect("A local Wiki origin requires a local Vault origin");
        assert!(
            wiki.to_str()
                .is_some_and(|origin| origin != vault && loopback_origin(origin)),
            "VAULT_LOCAL_WIKI_ORIGIN must be a distinct canonical loopback HTTP(S) origin"
        );
    }
    let mut files = vec![];
    let mut source = String::from("pub const ASSETS:&[(&str,&str,&[u8])]=&[\n");
    if env::var_os("CARGO_FEATURE_EMBEDDED_ASSETS").is_some() {
        assert!(
            root.join("index.html").is_file(),
            "Build complete vaultbrowser assets with index.html before enabling embedded-assets"
        );
        walk(&root, &root, &mut files);
        files.sort();
        let index = fs::read_to_string(root.join("index.html")).expect("read index.html");
        assert!(
            !index.trim().is_empty() && index.contains(".js"),
            "index.html must reference a JavaScript entrypoint"
        );
        assert!(
            files
                .iter()
                .any(|f| f.extension().is_some_and(|x| x == "js")
                    && fs::metadata(root.join(f)).is_ok_and(|m| m.len() > 0)),
            "assets require a nonempty JavaScript entrypoint"
        );
        for f in &files {
            let ext = f.extension().and_then(|x| x.to_str()).unwrap_or("");
            let mime = match ext {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                _ => "application/octet-stream",
            };
            source.push_str(&format!(
                "({:?},{:?},include_bytes!({:?})),\n",
                format!("/{}", f.display()),
                mime,
                root.join(f)
            ));
        }
    }
    source.push_str("];\n");
    if env::var_os("CARGO_FEATURE_EMBEDDED_ASSETS").is_some() {
        let local = [
            "VAULT_LOCAL_ORIGIN",
            "VAULT_LOCAL_HOST",
            "VAULT_LOCAL_II",
            "VAULT_LOCAL_WIKI_ORIGIN",
            "VAULT_LOCAL_NATIVE_CALLBACK",
        ]
        .iter()
        .any(|key| env::var_os(key).is_some());
        let synthetic = env::var_os("CARGO_FEATURE_SYNTHETIC_FUNDING_TEST_ONLY").is_some();
        if !local && !synthetic {
            for key in ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"] {
                assert!(
                    env::var(key).unwrap_or_default().is_empty(),
                    "Production assets require default compiler flags: {key}"
                );
            }
        }
        let metadata = format!(
            "{{\"embedded_assets\":true,\"local\":{local},\"synthetic\":{synthetic},\"assets\":{}}}",
            files.len()
        );
        source.push_str(&format!("#[cfg(target_arch = \"wasm32\")]\n#[used]\n#[unsafe(link_section = \"kinic:vault-build\")]\nstatic VAULT_BUILD: [u8; {}] = *b{:?};\n", metadata.len(), metadata));
    }
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("assets.rs"),
        source,
    )
    .unwrap();
}
