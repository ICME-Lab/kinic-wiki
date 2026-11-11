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
fn main() {
    let root =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../vaultbrowser/dist");
    println!("cargo:rerun-if-changed={}", root.display());
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_ORIGIN");
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_HOST");
    println!("cargo:rerun-if-env-changed=VAULT_LOCAL_II");
    let mut files = vec![];
    let mut source = String::from("pub const ASSETS:&[(&str,&str,&[u8])]=&[\n");
    if root.exists() {
        walk(&root, &root, &mut files);
        files.sort();
        for f in files {
            let ext = f.extension().and_then(|x| x.to_str()).unwrap_or("");
            let mime = match ext {
                "html" => "text/html; charset=utf-8",
                "js" => "text/javascript; charset=utf-8",
                "css" => "text/css; charset=utf-8",
                "svg" => "image/svg+xml",
                _ => "application/octet-stream",
            };
            source.push_str(&format!(
                "({:?},{:?},include_bytes!({:?})),\n",
                format!("/{}", f.display()),
                mime,
                root.join(&f)
            ));
        }
    } else if env::var("CARGO_CFG_TARGET_ARCH").unwrap() == "wasm32" {
        panic!("Run vaultbrowser build before building dedicated Vault Wasm")
    }
    source.push_str("];\n");
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("assets.rs"),
        source,
    )
    .unwrap();
}
