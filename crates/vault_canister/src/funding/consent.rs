//! Bounded ICRC-21 previews for Vault funding calls.
use super::{
    FundingConfig, PurchaseRequest, Status,
    api::load_funding_config,
    auth, generation,
    ledger::require_ledger,
    load, next_payment_attempt, payment_eligibility, quote_credits,
    reconciliation::{ScanAdmission, scan_admission},
    validate_quote_request,
};
use candid::{
    CandidType, Nat, Principal,
    de::{DecoderConfig, IDLDeserialize},
    utils::ArgumentDecoder,
};
use serde::Deserialize;
use vault_types::Error;

const MAX_ENVELOPE_BYTES: usize = 4096;
const MAX_ARGUMENT_BYTES: usize = 1024;
const MAX_MESSAGE_BYTES: usize = 1024;

#[derive(CandidType, Debug, Deserialize)]
pub(crate) struct Icrc21ConsentMessageRequest {
    pub arg: Vec<u8>,
    pub method: String,
    pub user_preferences: Icrc21ConsentMessageSpec,
}

#[derive(CandidType, Debug, Deserialize)]
pub(crate) struct Icrc21ConsentMessageSpec {
    pub metadata: Icrc21ConsentMessageMetadata,
    // Generic Markdown is the fallback for all display preferences.
    #[allow(dead_code)]
    pub device_spec: Option<Icrc21DeviceSpec>,
}

#[derive(CandidType, Debug, Deserialize)]
pub(crate) struct Icrc21ConsentMessageMetadata {
    pub utc_offset_minutes: Option<i16>,
    pub language: String,
}

#[derive(CandidType, Debug, Deserialize)]
pub(crate) enum Icrc21DeviceSpec {
    GenericDisplay,
    FieldsDisplay,
}

#[derive(CandidType, Debug)]
pub(crate) enum Icrc21ConsentMessage {
    GenericDisplayMessage(String),
}

#[derive(CandidType, Debug)]
pub(crate) struct Icrc21ConsentInfo {
    pub metadata: Icrc21ConsentMessageMetadata,
    pub consent_message: Icrc21ConsentMessage,
}

#[derive(CandidType, Debug)]
pub(crate) struct Icrc21ErrorInfo {
    pub description: String,
}

#[derive(CandidType, Debug)]
pub(crate) struct Icrc21GenericError {
    pub description: String,
    pub error_code: Nat,
}

#[derive(CandidType, Debug)]
pub(crate) enum Icrc21Error {
    #[allow(dead_code)]
    GenericError(Icrc21GenericError),
    #[allow(dead_code)]
    InsufficientPayment(Icrc21ErrorInfo),
    UnsupportedCanisterCall(Icrc21ErrorInfo),
    ConsentMessageUnavailable(Icrc21ErrorInfo),
}

#[derive(CandidType, Debug)]
pub(crate) enum Icrc21ConsentMessageResponse {
    Ok(Icrc21ConsentInfo),
    Err(Icrc21Error),
}

#[derive(CandidType)]
pub(crate) struct Icrc10SupportedStandard {
    name: String,
    url: String,
}

#[ic_cdk::query]
fn icrc10_supported_standards() -> Vec<Icrc10SupportedStandard> {
    vec![Icrc10SupportedStandard {
        name: "ICRC-21".into(),
        url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-21/ICRC-21.md".into(),
    }]
}

// The CDK exports custom-decoded arguments as blobs by default. Publish the wire record.
#[ic_cdk::update(hidden = true, decode_with = "decode_consent_request")]
#[candid::candid_method(update)]
fn icrc21_canister_call_consent_message(
    request: Icrc21ConsentMessageRequest,
) -> Icrc21ConsentMessageResponse {
    consent_for(
        ic_cdk::api::msg_caller(),
        ic_cdk::api::canister_self(),
        crate::now_nanos(),
        request,
    )
}

fn decode_consent_request(bytes: Vec<u8>) -> Icrc21ConsentMessageRequest {
    if bytes.len() <= MAX_ENVELOPE_BYTES
        && let Ok((request,)) = decode_exact(&bytes)
    {
        return request;
    }
    ic_cdk::trap("Invalid Vault consent request")
}

fn decode_exact<'a, T: ArgumentDecoder<'a>>(bytes: &'a [u8]) -> Result<T, Icrc21Error> {
    let mut config = DecoderConfig::new();
    config
        .set_max_type_len(32)
        .set_decoding_quota(32_768)
        .set_skipping_quota(0)
        .set_full_error_message(false);
    let invalid = || unsupported("Invalid Candid arguments for this Vault funding call.");
    let mut decoder = IDLDeserialize::new_with_config(bytes, &config).map_err(|_| invalid())?;
    let args = T::decode(&mut decoder).map_err(|_| invalid())?;
    if !decoder.is_done() {
        return Err(invalid());
    }
    decoder.done().map_err(|_| invalid())?;
    Ok(args)
}

fn decode_operation(arg: &[u8]) -> Result<Vec<u8>, Icrc21Error> {
    let (operation,): (Vec<u8>,) = decode_exact(arg)?;
    if operation.len() != 16 {
        return Err(funding_error(Error::InvalidInput));
    }
    Ok(operation)
}

fn unsupported(description: &str) -> Icrc21Error {
    Icrc21Error::UnsupportedCanisterCall(Icrc21ErrorInfo {
        description: description.into(),
    })
}

fn unavailable(description: &str) -> Icrc21Error {
    Icrc21Error::ConsentMessageUnavailable(Icrc21ErrorInfo {
        description: description.into(),
    })
}

fn funding_error(error: Error) -> Icrc21Error {
    match error {
        Error::InvalidInput => unsupported("Invalid funding arguments."),
        Error::Unauthorized => unavailable("Vault funding is unavailable for these terms."),
        Error::NotFound => unavailable("Payment operation was not found for this wallet."),
        Error::Conflict => unavailable("This action is unavailable for the current payment state."),
        Error::Expired => unavailable("This Vault quote or payment window has expired."),
        Error::Busy => unavailable("A Vault payment or reconciliation is already in progress."),
        Error::QuotaExceeded => unavailable("The Vault funding limit was reached."),
        Error::Storage | Error::KeyService => unavailable("Vault funding state is unavailable."),
    }
}

fn require_wallet(caller: Principal) -> Result<(), Icrc21Error> {
    auth(caller).map_err(|_| unavailable("This call requires an authenticated wallet."))
}

pub(super) fn consent_for(
    caller: Principal,
    spender: Principal,
    now: u64,
    request: Icrc21ConsentMessageRequest,
) -> Icrc21ConsentMessageResponse {
    if request.arg.len() > MAX_ARGUMENT_BYTES
        || request.method.len() > 64
        || request.user_preferences.metadata.language.len() > 64
    {
        return Icrc21ConsentMessageResponse::Err(unsupported(
            "Vault consent request is too large.",
        ));
    }
    match preview(caller, spender, now, &request.method, &request.arg) {
        Ok(message) if message.len() <= MAX_MESSAGE_BYTES => {
            Icrc21ConsentMessageResponse::Ok(Icrc21ConsentInfo {
                metadata: Icrc21ConsentMessageMetadata {
                    language: "en".into(),
                    utc_offset_minutes: None,
                },
                consent_message: Icrc21ConsentMessage::GenericDisplayMessage(message),
            })
        }
        Ok(_) => {
            Icrc21ConsentMessageResponse::Err(unavailable("Vault consent message is too large."))
        }
        Err(error) => Icrc21ConsentMessageResponse::Err(error),
    }
}

fn preview(
    caller: Principal,
    spender: Principal,
    now: u64,
    method: &str,
    arg: &[u8],
) -> Result<String, Icrc21Error> {
    match method {
        "get_funding_config" => {
            decode_exact::<()>(arg)?;
            Ok("# Read the public funding configuration\n\nReturn the configured ledger, recipient and credit conversion rate, if Vault funding is enabled.".into())
        }
        "account_balance" => {
            decode_exact::<()>(arg)?;
            require_wallet(caller)?;
            Ok("# Read your Vault prepaid cycle balance\n\nReturn the balance for the calling account.".into())
        }
        "payment_status" => {
            decode_operation(arg)?;
            require_wallet(caller)?;
            Ok("# Read a Vault payment status\n\nReturn your Vault payment record for this operation, including the payment terms and status if it exists.".into())
        }
        "list_payments" => {
            decode_exact::<()>(arg)?;
            require_wallet(caller)?;
            Ok("# List Vault payments\n\nReturn up to 16 of your Vault payment records, including payment terms and statuses.".into())
        }
        "quote_purchase" => {
            let (request,) = decode_exact(arg)?;
            require_wallet(caller)?;
            quote_preview(caller, spender, now, request).map_err(funding_error)
        }
        "pay_purchase" => payment_preview(caller, spender, now, arg, PaymentAction::Pay),
        "cancel_quote" => payment_preview(caller, spender, now, arg, PaymentAction::Cancel),
        "reconcile_purchase" => {
            payment_preview(caller, spender, now, arg, PaymentAction::Reconcile)
        }
        _ => Err(unsupported(
            "This Vault method does not support funding consent.",
        )),
    }
}

fn quote_preview(
    caller: Principal,
    spender: Principal,
    now: u64,
    request: PurchaseRequest,
) -> vault_types::Result<String> {
    validate_quote_request(&request)?;
    let (config, credits, fee) = crate::state::read(|db| {
        if let Some(payment) = load(db, caller, &request.operation)? {
            if payment.request != request {
                return Err(Error::Conflict);
            }
            let payment = payment.with_effective_status(now);
            if payment.status == Status::Expired {
                return Err(Error::Expired);
            }
            require_ledger(payment.config.ledger)?;
            return Ok((payment.config, payment.credits, Some(payment.fee)));
        }
        let config = load_funding_config(db)?.ok_or(Error::Unauthorized)?;
        let credits = quote_credits(&request, &config, now)?;
        Ok((config, credits, None))
    })?;
    let details = terms(caller, spender, &request, &config, credits);
    let message = match fee {
        Some(fee) => format!(
            "# Read the existing Vault payment\n\nThis returns the stored payment record and does not debit funds.\n\n{details}\n\nQuoted ledger transfer fee: `{}` KINIC",
            kinic_amount(u128::from(fee))
        ),
        None => format!(
            "# Prepare a Vault funding quote\n\nPreparing a quote does not debit funds. Review the exact ledger transfer fee in the returned quote before paying.\n\n{details}"
        ),
    };
    Ok(message)
}

enum PaymentAction {
    Pay,
    Cancel,
    Reconcile,
}

fn payment_preview(
    caller: Principal,
    spender: Principal,
    now: u64,
    arg: &[u8],
    action: PaymentAction,
) -> Result<String, Icrc21Error> {
    let operation = decode_operation(arg)?;
    require_wallet(caller)?;
    let preview = crate::state::read(|db| {
        let payment = load(db, caller, &operation)?.ok_or(Error::NotFound)?;
        let details = terms(
            payment.wallet,
            spender,
            &payment.request,
            &payment.config,
            payment.credits,
        );
        let message = match action {
            PaymentAction::Pay => {
                require_ledger(payment.config.ledger)?;
                if payment.status == Status::Expired {
                    return Err(Error::Expired);
                }
                payment_eligibility(&payment, generation(db)?, now)?;
                next_payment_attempt(&payment)?;
                let total = u128::from(payment.request.amount_e8s) + u128::from(payment.fee);
                let title = if payment.status == Status::Quoted {
                    "Pay the Vault funding quote"
                } else {
                    "Resubmit the same Vault payment"
                };
                format!(
                    "# {title}\n\nUse the payer's ledger allowance to fund the beneficiary's Vault prepaid balance.\n\n{details}\n\nLedger transfer fee: `{}` KINIC\n\nTotal ledger debit: `{}` KINIC",
                    kinic_amount(u128::from(payment.fee)),
                    kinic_amount(total),
                )
            }
            PaymentAction::Cancel if payment.status == Status::Quoted => format!(
                "# Cancel the Vault funding quote\n\nThis makes the quote unusable for payment and does not debit funds or change the ledger allowance.\n\n{details}"
            ),
            PaymentAction::Cancel => return Err(Error::Conflict),
            PaymentAction::Reconcile => {
                let explanation = match scan_admission(db, &payment, now)? {
                    ScanAdmission::AlreadyPaid => "Return the recorded payment confirmation.",
                    ScanAdmission::RecoverQuote => {
                        "Recover the quote if transfer preparation was interrupted before dispatch."
                    }
                    ScanAdmission::History { .. } => {
                        require_ledger(payment.config.ledger)?;
                        "Check ledger history for an earlier transfer. This may update payment recovery progress and credit the beneficiary if the transfer is verified."
                    }
                };
                format!(
                    "# Reconcile a Vault payment\n\n{explanation} This does not send a new transfer.\n\n{details}"
                )
            }
        };
        Ok(message)
    });
    preview.map_err(|error| match (action, error) {
        (PaymentAction::Cancel, Error::Conflict) => {
            unavailable("This Vault quote can no longer be cancelled.")
        }
        (PaymentAction::Reconcile, Error::Conflict) => {
            unavailable("This Vault payment cannot be reconciled.")
        }
        (_, error) => funding_error(error),
    })
}

fn terms(
    payer: Principal,
    spender: Principal,
    request: &PurchaseRequest,
    config: &FundingConfig,
    credits: u64,
) -> String {
    let operation: String = request
        .operation
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!(
        "Operation: `{operation}`\n\nLedger: `{}`\n\nSpender canister: `{spender}`\n\nPayer wallet: `{payer}`\n\nRecipient: `{}`\n\nVault beneficiary: `{}`\n\nPayment: `{}` KINIC\n\nVault credit: `{credits}` cycles",
        config.ledger,
        config.recipient,
        request.beneficiary,
        kinic_amount(u128::from(request.amount_e8s)),
    )
}

fn kinic_amount(e8s: u128) -> String {
    let whole = e8s / 100_000_000;
    let fraction = e8s % 100_000_000;
    if fraction == 0 {
        whole.to_string()
    } else {
        let digits = format!("{fraction:08}");
        format!("{whole}.{}", digits.trim_end_matches('0'))
    }
}
