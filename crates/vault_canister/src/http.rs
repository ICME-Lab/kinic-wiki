use candid::{CandidType, Deserialize};
use ic_http_certification::{
    CERTIFICATE_EXPRESSION_HEADER_NAME, DefaultCelBuilder, DefaultResponseCertification,
    HttpCertification, HttpCertificationPath, HttpCertificationTree, HttpCertificationTreeEntry,
    HttpResponse as Response, utils::add_v2_certificate_header,
};
include!(concat!(env!("OUT_DIR"), "/assets.rs"));
#[derive(CandidType, Deserialize)]
pub(crate) struct HttpRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    certificate_version: Option<u16>,
}
#[derive(CandidType, Deserialize)]
pub(crate) struct HttpResponse {
    status_code: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    upgrade: Option<bool>,
}
type Entry = (
    HttpCertificationPath<'static>,
    HttpCertificationTreeEntry<'static>,
    Response<'static>,
);
thread_local! {static ENTRIES:std::cell::RefCell<Vec<Entry>>=const{std::cell::RefCell::new(Vec::new())};static TREE:std::cell::RefCell<HttpCertificationTree>=std::cell::RefCell::new(HttpCertificationTree::default());}
pub(crate) fn security_headers() -> Vec<(String, String)> {
    let mut headers:Vec<(String,String)>=vec![
 ("Content-Security-Policy".into(),"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://icp0.io https://*.icp0.io; img-src 'self' blob:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'".into()),
 ("Referrer-Policy".into(),"no-referrer".into()),("X-Content-Type-Options".into(),"nosniff".into()),("X-Frame-Options".into(),"DENY".into()),
 // Allow the explicitly opened Internet Identity popup to retain its opener handshake.
 ("Cross-Origin-Opener-Policy".into(),"same-origin-allow-popups".into()),("Cache-Control".into(),"no-store".into()),
 // Vault is a private app shell: keep every path, including config and assets, out of search indexes.
 ("X-Robots-Tag".into(),"noindex, nofollow, noarchive, nosnippet".into())];
    if let Some(host) = option_env!("VAULT_LOCAL_HOST") {
        headers[0].1 = headers[0].1.replace(
            "connect-src \'self\'",
            &format!("connect-src \'self\' {host}"),
        );
    }
    headers
}
const WIKI_ORIGIN: &str = "https://wiki.kinic.xyz";
const EMBED_PREFIX: &str = "/embed/";
const PICK_PATH: &str = "/pick";

enum HtmlPolicy<'a> {
    Default,
    Embed(&'a str),
    Picker,
    NativeLocal,
}

fn entry(
    path: HttpCertificationPath<'static>,
    body: Vec<u8>,
    mime: &str,
    policy: HtmlPolicy<'_>,
) -> Entry {
    let cel = DefaultCelBuilder::response_only_certification()
        .with_response_certification(DefaultResponseCertification::certified_response_headers(
            vec![
                "Content-Type",
                "Content-Security-Policy",
                "Referrer-Policy",
                "X-Content-Type-Options",
                "X-Frame-Options",
                "Cross-Origin-Opener-Policy",
                "Cache-Control",
                "X-Robots-Tag",
                "Access-Control-Allow-Origin",
            ],
        ))
        .build();
    let mut headers = security_headers();
    match policy {
        HtmlPolicy::Default => {}
        HtmlPolicy::NativeLocal => headers.push(("Access-Control-Allow-Origin".into(), "*".into())),
        HtmlPolicy::Embed(origin) => {
            let csp = &mut headers
                .iter_mut()
                .find(|(name, _)| name == "Content-Security-Policy")
                .unwrap()
                .1;
            *csp = csp.replace(
                "frame-ancestors 'none'",
                &format!("frame-ancestors {origin}"),
            );
            headers.retain(|(name, _)| name != "X-Frame-Options");
        }
        HtmlPolicy::Picker => {
            let coop = &mut headers
                .iter_mut()
                .find(|(name, _)| name == "Cross-Origin-Opener-Policy")
                .unwrap()
                .1;
            *coop = "unsafe-none".into();
        }
    }
    headers.push(("Content-Type".into(), mime.into()));
    headers.push((CERTIFICATE_EXPRESSION_HEADER_NAME.into(), cel.to_string()));
    let response = Response::ok(body, headers).with_upgrade(false).build();
    let cert =
        HttpCertification::response_only(&cel, &response, None).expect("asset certification");
    let e = HttpCertificationTreeEntry::new(path.clone(), cert);
    (path, e, response)
}
fn html_fallbacks(index: &[u8], mime: &str, wiki_origin: Option<&str>) -> Vec<Entry> {
    let mut routes = vec![
        entry(
            HttpCertificationPath::wildcard(""),
            index.to_vec(),
            mime,
            HtmlPolicy::Default,
        ),
        entry(
            HttpCertificationPath::exact(PICK_PATH),
            index.to_vec(),
            mime,
            HtmlPolicy::Picker,
        ),
    ];
    if let Some(origin) = wiki_origin {
        // The certification tree treats a trailing slash as its own segment.
        // A separate exact route preserves the deny policy at /embed.
        routes.extend([
            entry(
                HttpCertificationPath::exact("/embed"),
                index.to_vec(),
                mime,
                HtmlPolicy::Default,
            ),
            entry(
                HttpCertificationPath::wildcard("/embed"),
                index.to_vec(),
                mime,
                HtmlPolicy::Embed(origin),
            ),
        ]);
    }
    routes
}

fn local_derivation_origin(id: &str, host: &url::Url) -> String {
    let port = host
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    format!("{}://{id}.localhost{port}", host.scheme())
}

const PRODUCTION_NATIVE_CALLBACK: &str = "https://vault.kinic.xyz/ios-vault-auth-callback";

fn native_callback_entries_for_host(
    callback: &str,
    expected_host: &str,
) -> std::result::Result<Vec<Entry>, ()> {
    let url = url::Url::parse(callback).map_err(|_| ())?;
    if url.scheme() != "https"
        || url.host_str() != Some(expected_host)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/ios-vault-auth-callback"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != callback
    {
        return Err(());
    }
    Ok(vec![
        entry(HttpCertificationPath::exact("/.well-known/ii-auth-callbacks"), serde_json::to_vec(&serde_json::json!({"callbacks":[callback]})).unwrap(), "application/json", HtmlPolicy::NativeLocal),
        entry(HttpCertificationPath::exact("/.well-known/apple-app-site-association"), br#"{"webcredentials":{"apps":["AKN976G7AK.xyz.kinic.ios.KinicWiki"]}}"#.to_vec(), "application/json", HtmlPolicy::NativeLocal),
        entry(HttpCertificationPath::exact("/ios-vault-auth-callback"), b"<!doctype html><meta charset=utf-8><title>Kinic Vault</title><p>Return to the Kinic app to finish signing in.</p>".to_vec(), "text/html; charset=utf-8", HtmlPolicy::Default),
    ])
}

fn native_callback_entries(callback: &str) -> std::result::Result<Vec<Entry>, ()> {
    native_callback_entries_for_host(callback, "vault.localhost")
}

fn select_entry<'a>(entries: &'a [Entry], path: &str) -> Option<&'a Entry> {
    let exact = HttpCertificationPath::exact(path);
    entries.iter().find(|(p, _, _)| *p == exact).or_else(|| {
        if path.starts_with(EMBED_PREFIX) {
            return entries
                .iter()
                .find(|(p, _, _)| *p == HttpCertificationPath::wildcard("/embed"))
                .or_else(|| {
                    entries
                        .iter()
                        .find(|(p, _, _)| *p == HttpCertificationPath::wildcard(""))
                });
        }
        entries
            .iter()
            .find(|(p, _, _)| *p == HttpCertificationPath::wildcard(""))
    })
}

pub fn initialize() {
    let id = ic_cdk::api::canister_self().to_text();
    let local = option_env!("VAULT_LOCAL_ORIGIN");
    let origin = local.unwrap_or("https://vault.kinic.xyz");
    let (host, derivation, provider) = if local.is_some() {
        let (Some(host), Some(provider)) = (
            option_env!("VAULT_LOCAL_HOST"),
            option_env!("VAULT_LOCAL_II"),
        ) else {
            panic!("local Vault requires both host and II provider");
        };
        let parsed = url::Url::parse(host).expect("local host");
        assert!(matches!(parsed.host_str(), Some("localhost" | "127.0.0.1")));
        assert!(
            url::Url::parse(origin)
                .unwrap()
                .host_str()
                .unwrap()
                .ends_with(".localhost")
        );
        (
            host.to_string(),
            local_derivation_origin(&id, &parsed),
            provider.to_string(),
        )
    } else {
        (
            "https://icp0.io".into(),
            format!("https://{id}.icp0.io"),
            "https://id.ai".into(),
        )
    };
    let wiki_origin = if local.is_some() {
        option_env!("VAULT_LOCAL_WIKI_ORIGIN")
    } else {
        Some(WIKI_ORIGIN)
    };
    let config = serde_json::json!({"canister":id,"host":host,"derivationOrigin":derivation,"identityProvider":provider,"origin":origin,"wikiOrigin":wiki_origin,"local":local.is_some(),"fundingMode":crate::funding::FUNDING_MODE});
    let mut entries = vec![];
    if local.is_some() {
        if let Some(callback) = option_env!("VAULT_LOCAL_NATIVE_CALLBACK") {
            entries.extend(native_callback_entries(callback).expect(
                "local native callback must use https://vault.localhost/ios-vault-auth-callback",
            ));
        }
    } else {
        entries.extend(
            native_callback_entries_for_host(PRODUCTION_NATIVE_CALLBACK, "vault.kinic.xyz")
                .expect("production native callback must be valid"),
        );
    }
    for (path, mime, bytes) in ASSETS {
        entries.push(entry(
            HttpCertificationPath::exact((*path).to_string()),
            bytes.to_vec(),
            mime,
            HtmlPolicy::Default,
        ));
        if *path == "/index.html" {
            entries.extend(html_fallbacks(bytes, mime, wiki_origin));
        }
    }
    entries.push(entry(
        HttpCertificationPath::exact("/config.json".to_string()),
        serde_json::to_vec(&config).unwrap(),
        "application/json",
        HtmlPolicy::Default,
    ));
    entries.push(entry(
        HttpCertificationPath::exact("/.well-known/ii-alternative-origins".to_string()),
        serde_json::to_vec(&serde_json::json!({"alternativeOrigins":[origin]})).unwrap(),
        "application/json",
        HtmlPolicy::Default,
    ));
    entries.push(entry(
        HttpCertificationPath::exact("/.well-known/ic-domains".to_string()),
        if local.is_none() {
            b"vault.kinic.xyz".to_vec()
        } else {
            vec![]
        },
        "text/plain",
        HtmlPolicy::Default,
    ));
    let mut tree = HttpCertificationTree::default();
    for (_, entry, _) in &entries {
        tree.insert(entry)
    }
    ic_cdk::api::certified_data_set(tree.root_hash());
    TREE.with(|t| *t.borrow_mut() = tree);
    ENTRIES.with(|e| *e.borrow_mut() = entries);
}
#[ic_cdk::query]
fn http_request(request: HttpRequest) -> HttpResponse {
    let path = request.url.split('?').next().unwrap_or("/");
    ENTRIES.with(|entries| {
        let entries = entries.borrow();
        let Some((p, e, r)) = select_entry(&entries, path) else {
            return HttpResponse {
                status_code: 404,
                headers: security_headers(),
                body: vec![],
                upgrade: Some(false),
            };
        };
        let mut response = r.clone();
        TREE.with(|t| {
            let witness = t.borrow().witness(e, path).expect("asset witness");
            if let Some(cert) = ic_cdk::api::data_certificate() {
                add_v2_certificate_header(&cert, &mut response, &witness, &p.to_expr_path())
            }
        });
        HttpResponse {
            status_code: response.status_code().as_u16(),
            headers: response.headers().to_vec(),
            body: response.body().to_vec(),
            upgrade: Some(false),
        }
    })
}

#[cfg(test)]
mod route_tests {
    use super::*;

    #[test]
    fn native_local_callbacks_are_exact_terminal_and_cors_readable() {
        let routes =
            native_callback_entries("https://vault.localhost/ios-vault-auth-callback").unwrap();
        let (_, _, declaration) = select_entry(&routes, "/.well-known/ii-auth-callbacks").unwrap();
        let body: serde_json::Value = serde_json::from_slice(declaration.body()).unwrap();
        assert_eq!(
            body["callbacks"],
            serde_json::json!(["https://vault.localhost/ios-vault-auth-callback"])
        );
        assert!(
            declaration
                .headers()
                .contains(&("Access-Control-Allow-Origin".into(), "*".into()))
        );
        let (_, _, callback) = select_entry(&routes, "/ios-vault-auth-callback").unwrap();
        assert_eq!(callback.status_code().as_u16(), 200);
        assert!(
            !callback
                .headers()
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case("location"))
        );
        let (_, _, aasa) =
            select_entry(&routes, "/.well-known/apple-app-site-association").unwrap();
        let aasa: serde_json::Value = serde_json::from_slice(aasa.body()).unwrap();
        assert_eq!(
            aasa["webcredentials"]["apps"],
            serde_json::json!(["AKN976G7AK.xyz.kinic.ios.KinicWiki"])
        );
        for bad in [
            "http://vault.localhost/ios-vault-auth-callback",
            "https://evil.test/ios-vault-auth-callback",
            "https://vault.localhost/ios-vault-auth-callback?state=x",
            "https://vault.localhost:9443/ios-vault-auth-callback",
        ] {
            assert!(native_callback_entries(bad).is_err());
        }
    }

    #[test]
    fn native_production_callbacks_serve_certified_vault_origin_only() {
        let routes =
            native_callback_entries_for_host(PRODUCTION_NATIVE_CALLBACK, "vault.kinic.xyz")
                .unwrap();
        let (_, _, declaration) = select_entry(&routes, "/.well-known/ii-auth-callbacks").unwrap();
        let body: serde_json::Value = serde_json::from_slice(declaration.body()).unwrap();
        assert_eq!(
            body["callbacks"],
            serde_json::json!(["https://vault.kinic.xyz/ios-vault-auth-callback"])
        );
        assert!(
            declaration
                .headers()
                .contains(&("Access-Control-Allow-Origin".into(), "*".into()))
        );
        let (_, _, aasa) =
            select_entry(&routes, "/.well-known/apple-app-site-association").unwrap();
        let aasa: serde_json::Value = serde_json::from_slice(aasa.body()).unwrap();
        assert_eq!(
            aasa["webcredentials"]["apps"],
            serde_json::json!(["AKN976G7AK.xyz.kinic.ios.KinicWiki"])
        );
        assert!(
            native_callback_entries_for_host(
                "https://wiki.kinic.xyz/ios-vault-auth-callback",
                "vault.kinic.xyz"
            )
            .is_err()
        );
    }

    #[test]
    fn native_local_tls_preserves_the_web_derivation_origin() {
        assert_eq!(
            local_derivation_origin(
                "test-canister",
                &url::Url::parse("http://127.0.0.1:8080").unwrap()
            ),
            "http://test-canister.localhost:8080"
        );
        assert_eq!(
            local_derivation_origin(
                "test-canister",
                &url::Url::parse("https://localhost").unwrap()
            ),
            "https://test-canister.localhost"
        );
    }

    #[test]
    fn certified_html_routes_scope_framing_and_opener_headers() {
        let entries = html_fallbacks(b"index", "text/html", Some("https://wiki.kinic.xyz"));
        let mut tree = HttpCertificationTree::default();
        for (_, entry, _) in &entries {
            tree.insert(entry);
        }
        for (path, ancestor, xfo, coop) in [
            ("/", "'none'", true, "same-origin-allow-popups"),
            ("/pick", "'none'", true, "unsafe-none"),
            ("/pick/extra", "'none'", true, "same-origin-allow-popups"),
            (
                "/embedded/object",
                "'none'",
                true,
                "same-origin-allow-popups",
            ),
            ("/embed", "'none'", true, "same-origin-allow-popups"),
            (
                "/embed/01010101010101010101010101010101/02020202020202020202020202020202",
                "https://wiki.kinic.xyz",
                false,
                "same-origin-allow-popups",
            ),
        ] {
            let (_, entry, response) = select_entry(&entries, path).unwrap();
            let headers = response.headers();
            let get = |name| {
                headers
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.as_str())
            };
            assert!(
                get("Content-Security-Policy")
                    .unwrap()
                    .contains(&format!("frame-ancestors {ancestor};")),
                "{path}"
            );
            assert_eq!(get("X-Frame-Options"), xfo.then_some("DENY"), "{path}");
            assert_eq!(get("Cross-Origin-Opener-Policy"), Some(coop), "{path}");
            assert!(tree.witness(entry, path).is_ok(), "{path}");
        }
    }
}
