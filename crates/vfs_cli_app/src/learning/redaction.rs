//! Common redaction before hook input is persisted or supplied to learning.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// Redact sensitive values recursively while retaining event identity and usage.
pub fn redact(value: &mut Value) {
    // Capture once per event, without formatting environment values into any
    // diagnostic. Non-Unicode entries cannot occur in JSON strings.
    let secrets = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
        .filter(|(key, value)| sensitive_key(key) && value.len() >= 8)
        .map(|(_, value)| value)
        .collect::<Vec<_>>();
    redact_with_secrets(value, &secrets);
}

const REDACTED: &str = "[REDACTED]";

fn sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "token",
        "secret",
        "password",
        "cookie",
        "authorization",
        "credential",
        "apikey",
        "bearer",
        "privatekey",
    ]
    .iter()
    .any(|part| normalized.contains(part))
}

fn token_metric(key: &str, value: &Value) -> bool {
    let normalized = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect::<String>();
    value.is_number() && (normalized.ends_with("tokens") || normalized.ends_with("tokencount"))
}

static RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"\bsk-[A-Za-z0-9_-]{20,}\b", REDACTED),
        (r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", REDACTED),
        (r"\bghp_[A-Za-z0-9]{20,}\b", REDACTED),
        (r"\bgithub_pat_[A-Za-z0-9_]{20,}\b", REDACTED),
        (r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b", REDACTED),
        (r"-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----", REDACTED),
        (r"(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]+", "${1}[REDACTED]"),
        (r#"(?i)(?P<prefix>"[^"\\]*(?:api[_.-]?key|token|secret|password|cookie|authorization|credential|bearer|private[_.-]?key)[^"\\]*"\s*:\s*")(?P<secret>(?:\\.|[^"\\])*)(?P<suffix>")"#, "${prefix}[REDACTED]${suffix}"),
        // Header values can contain whitespace, semicolons, and multiple
        // cookies. Redact the whole value instead of only its first word.
        (r"(?im)\b((?:set-cookie|cookie|authorization)\s*[:=]\s*)[^\r\n]+", "${1}[REDACTED]"),
        (r#"(?i)\b([A-Za-z0-9_.-]*(?:api[_.-]?key|token|secret|password|cookie|credential|bearer|private[_.-]?key)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s'"`]+)"#, "${1}${2}[REDACTED]"),
    ].into_iter().map(|(pattern, replacement)| {
        (Regex::new(pattern).expect("static secret redaction regex"), replacement)
    }).collect()
});

fn redact_with_secrets(value: &mut Value, secrets: &[String]) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                if sensitive_key(key) && !token_metric(key, value) {
                    *value = Value::String(REDACTED.into());
                } else {
                    redact_with_secrets(value, secrets);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                redact_with_secrets(value, secrets);
            }
        }
        Value::String(text) => {
            for secret in secrets {
                *text = text.replace(secret, REDACTED);
            }
            for (regex, replacement) in RULES.iter() {
                *text = regex.replace_all(text, *replacement).into_owned();
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_unregistered_authorization_assignment_and_cookie_secrets() {
        let mut value = json!({"text": "Authorization: Bearer unknown-env-credential-123456789\nAPI_KEY='assignment-secret' cookie: session=private-session; csrf=private-csrf"});
        redact(&mut value);
        let rendered = value.to_string();
        for secret in [
            "unknown-env-credential",
            "assignment-secret",
            "private-session",
            "private-csrf",
        ] {
            assert!(!rendered.contains(secret), "a secret survived redaction");
        }
        assert!(rendered.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_quoted_json_and_normalized_nested_keys() {
        let mut value = json!({
            "run_id": "run-1", "turn_id": "turn-2", "tool_use_id": "call-3",
            "usage": {"input_tokens": 17, "output_tokens": 21, "total_tokens": 38},
            "records": [{"COOKIE": "cookie-secret", "API_KEY": "api-secret", "api.key": "dot-secret", "api-key": "dash-secret", "apikey": "plain-secret", "Authorization": "auth-secret", "clientCredential": "cred-secret", "private_key": "private-secret"}],
            "text": r#"response: {"API_KEY":"escaped-secret", "password":"quoted-secret"}"#,
        });
        redact(&mut value);
        let rendered = value.to_string();
        for secret in [
            "cookie-secret",
            "api-secret",
            "dot-secret",
            "dash-secret",
            "plain-secret",
            "auth-secret",
            "cred-secret",
            "private-secret",
            "escaped-secret",
            "quoted-secret",
        ] {
            assert!(
                !rendered.contains(secret),
                "a nested secret survived redaction"
            );
        }
        assert_eq!(value["run_id"], "run-1");
        assert_eq!(value["turn_id"], "turn-2");
        assert_eq!(value["tool_use_id"], "call-3");
        assert_eq!(value["usage"]["input_tokens"], 17);
        assert_eq!(value["usage"]["total_tokens"], 38);
    }

    #[test]
    fn redacts_known_tokens_aws_slack_and_multiline_private_keys() {
        let mut value = json!([
            "prefix sk-proj-abcdefghijklmnopqrstuvwxyz suffix",
            "AKIAABCDEFGHIJKLMNOP ASIAABCDEFGHIJKLMNOP",
            "ghp_abcdefghijklmnopqrstuvwxyz github_pat_abcdefghijklmnopqrstuvwxyz",
            concat!("xox", "b-1234567890-abcdefghijklmnopqrstuv"),
            "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----",
            "-----BEGIN RSA PRIVATE KEY-----\nrsa-private-material\n-----END RSA PRIVATE KEY-----",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nopenssh-private-material\n-----END OPENSSH PRIVATE KEY-----"
        ]);
        redact(&mut value);
        let rendered = value.to_string();
        for secret in [
            "abcdefghijklmnopqrstuvwxyz",
            "ABCDEFGHIJKLMNOP",
            "abcdefghijklmnopqrstuv",
            "private-key-material",
            "rsa-private-material",
            "openssh-private-material",
        ] {
            assert!(!rendered.contains(secret), "a token survived redaction");
        }
        assert_eq!(value[0], "prefix [REDACTED] suffix");
        assert_eq!(value[4], "[REDACTED]");
    }

    #[test]
    fn masks_configured_environment_values_without_needing_a_token_prefix() {
        let mut value = json!({"text": "tool printed opaque-environment-value in its output"});
        redact_with_secrets(&mut value, &["opaque-environment-value".to_owned()]);
        assert_eq!(value["text"], "tool printed [REDACTED] in its output");
        assert!(sensitive_key("CUSTOM_API_KEY"));
        assert!(sensitive_key("CUSTOM.AUTHORIZATION"));
        assert!(sensitive_key("SERVICE_COOKIE"));
        assert!(!sensitive_key("run_id"));
        assert!(!sensitive_key("turn_id"));
    }

    #[test]
    fn redaction_is_idempotent_and_preserves_nonsecret_values() {
        let mut value = json!({"task": "fix API migration", "count": 2, "okay": true, "none": null, "token": "secret-value"});
        redact(&mut value);
        assert_eq!(value["token"], "[REDACTED]");
        assert_eq!(value["task"], "fix API migration");
        let first = value.clone();
        redact(&mut value);
        assert_eq!(first, value);
    }
}
