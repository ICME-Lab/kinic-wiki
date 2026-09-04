// Where: crates/vfs_cli_core/src/commands/cycles.rs
// What: Cycles subcommand handlers and browser helpers.
// Why: Mechanical split out of commands.rs by command family.
use super::*;

pub fn open_database_cycles_page(browser_origin: Option<&str>, database_id: &str) -> Result<()> {
    let url = database_cycles_url(browser_origin, database_id)?;
    println!("{url}");
    if let Err(error) = open_browser_url(&url) {
        eprintln!("{}", browser_open_warning(&error));
    }
    Ok(())
}

pub fn database_cycles_url(browser_origin: Option<&str>, database_id: &str) -> Result<String> {
    let origin = browser_origin
        .map(str::to_string)
        .or_else(|| std::env::var("KINIC_WIKI_BROWSER_ORIGIN").ok())
        .unwrap_or_else(|| DEFAULT_BROWSER_ORIGIN.to_string());
    let origin = origin.trim_end_matches('/');
    if origin.is_empty() {
        return Err(anyhow!("browser origin must not be empty"));
    }
    if !is_browser_cycles_database_id(database_id) {
        return Err(anyhow!("database_id contains unsupported characters"));
    }
    Ok(format!(
        "{origin}/cycles?database_id={}",
        query_encode(database_id)
    ))
}

pub(crate) fn is_browser_cycles_database_id(database_id: &str) -> bool {
    !database_id.is_empty()
        && database_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub(crate) fn parse_kinic_amount_e8s(value: &str) -> Result<u64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("KINIC amount must not be empty"));
    }
    let (whole, fractional) = match trimmed.split_once('.') {
        Some((whole, fractional)) => (whole, Some(fractional)),
        None => (trimmed, None),
    };
    if whole.is_empty() || !whole.chars().all(|character| character.is_ascii_digit()) {
        return Err(anyhow!(
            "KINIC amount must be a positive decimal with up to {} fractional digits",
            KINIC_DECIMALS
        ));
    }
    let fractional = fractional.unwrap_or("");
    if fractional.is_empty() && trimmed.contains('.') {
        return Err(anyhow!(
            "KINIC amount must be a positive decimal with up to {} fractional digits",
            KINIC_DECIMALS
        ));
    }
    if fractional.len() > usize::from(KINIC_DECIMALS)
        || !fractional
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        return Err(anyhow!(
            "KINIC amount must be a positive decimal with up to {} fractional digits",
            KINIC_DECIMALS
        ));
    }
    let whole = whole
        .parse::<u128>()
        .map_err(|_| anyhow!("KINIC amount exceeds u64 e8s limit"))?;
    let fractional_e8s = if fractional.is_empty() {
        0
    } else {
        let padded = format!("{fractional:0<width$}", width = usize::from(KINIC_DECIMALS));
        padded
            .parse::<u128>()
            .map_err(|_| anyhow!("KINIC amount exceeds u64 e8s limit"))?
    };
    let amount = whole
        .checked_mul(u128::from(kinic_base_units_per_token()))
        .and_then(|amount| amount.checked_add(fractional_e8s))
        .ok_or_else(|| anyhow!("KINIC amount exceeds u64 e8s limit"))?;
    if amount == 0 {
        return Err(anyhow!("KINIC amount must be positive"));
    }
    u64::try_from(amount).map_err(|_| anyhow!("KINIC amount exceeds u64 e8s limit"))
}

pub(crate) fn query_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(char::from(byte));
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

pub fn open_browser_url(url: &str) -> Result<()> {
    let status = if cfg!(target_os = "macos") {
        ProcessCommand::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        ProcessCommand::new("rundll32")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .status()
    } else {
        ProcessCommand::new("xdg-open").arg(url).status()
    };
    let status = status.map_err(|error| anyhow!("failed to open browser: {error}"))?;
    if !status.success() {
        return Err(anyhow!("failed to open browser: exit status {status}"));
    }
    Ok(())
}

pub(crate) fn browser_open_warning(error: &anyhow::Error) -> String {
    format!("warning: could not open browser automatically; open the URL manually: {error}")
}

pub(crate) async fn run_cycles_command(client: &impl VfsApi, command: CyclesCommand) -> Result<()> {
    match command {
        CyclesCommand::Config { json } => {
            let config = client.get_cycles_billing_config().await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&CyclesBillingConfigOutput::new(
                        config,
                        KINIC_LEDGER_FEE_E8S
                    ))?
                );
            } else {
                for line in cycles_config_lines(&config, KINIC_LEDGER_FEE_E8S) {
                    println!("{line}");
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub(crate) struct CyclesBillingConfigOutput {
    kinic_ledger_canister_id: String,
    billing_authority_id: String,
    iap_authority_id: String,
    cycles_per_kinic: u64,
    min_update_cycles: u64,
    top_up: CyclesTopUpConfig,
    ledger_fee_e8s: u64,
}

impl CyclesBillingConfigOutput {
    fn new(config: CyclesBillingConfig, ledger_fee_e8s: u64) -> Self {
        Self {
            kinic_ledger_canister_id: config.kinic_ledger_canister_id,
            billing_authority_id: config.billing_authority_id,
            iap_authority_id: config.iap_authority_id,
            cycles_per_kinic: config.cycles_per_kinic,
            min_update_cycles: config.min_update_cycles,
            top_up: config.top_up,
            ledger_fee_e8s,
        }
    }
}

pub(crate) fn cycles_config_lines(
    config: &CyclesBillingConfig,
    ledger_fee_e8s: u64,
) -> Vec<String> {
    vec![
        format!(
            "kinic_ledger_canister_id\t{}",
            config.kinic_ledger_canister_id
        ),
        format!("billing_authority_id\t{}", config.billing_authority_id),
        format!("iap_authority_id\t{}", config.iap_authority_id),
        format!("cycles_per_kinic\t{}", config.cycles_per_kinic),
        format!("min_update_cycles\t{}", config.min_update_cycles),
        format!("top_up_enabled\t{}", config.top_up.enabled),
        format!(
            "top_up_launcher_principal\t{}",
            config.top_up.launcher_principal
        ),
        format!(
            "top_up_threshold_cycles\t{}",
            config.top_up.threshold_cycles
        ),
        format!("ledger_fee_e8s\t{ledger_fee_e8s}"),
    ]
}

pub(crate) fn cycles_for_payment_amount_e8s(
    payment_amount_e8s: u64,
    config: &CyclesBillingConfig,
) -> Result<u64> {
    if payment_amount_e8s == 0 {
        return Err(anyhow!("cycles purchase payment amount must be positive"));
    }
    let cycles = u128::from(payment_amount_e8s)
        .checked_mul(u128::from(config.cycles_per_kinic))
        .ok_or_else(|| anyhow!("cycles purchase amount overflow"))?
        / u128::from(kinic_base_units_per_token());
    let cycles =
        u64::try_from(cycles).map_err(|_| anyhow!("cycles purchase amount exceeds u64"))?;
    if cycles == 0 {
        return Err(anyhow!("cycles purchase amount is too small"));
    }
    Ok(cycles)
}
