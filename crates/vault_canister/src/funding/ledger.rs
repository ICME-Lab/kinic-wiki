//! ICRC wire records, bounded calls and conservative transfer outcome mapping.
use super::{Outcome, Payment, Status};
use candid::{CandidType, Nat, Principal};
use serde::Deserialize;
use vault_types::{Error, Result};

#[derive(CandidType, Deserialize)]
struct Account {
    owner: Principal,
    subaccount: Option<Vec<u8>>,
}
#[derive(CandidType, Deserialize)]
struct TransferFromArg {
    spender_subaccount: Option<Vec<u8>>,
    from: Account,
    to: Account,
    amount: Nat,
    fee: Option<Nat>,
    memo: Option<Vec<u8>>,
    created_at_time: Option<u64>,
}
#[derive(CandidType, Deserialize)]
enum TransferError {
    BadFee { expected_fee: Nat },
    BadBurn { min_burn_amount: Nat },
    InsufficientFunds { balance: Nat },
    InsufficientAllowance { allowance: Nat },
    TooOld,
    CreatedInFuture { ledger_time: u64 },
    Duplicate { duplicate_of: Nat },
    TemporarilyUnavailable,
    GenericError { error_code: Nat, message: String },
}
pub(super) fn nat(n: &Nat) -> Option<u64> {
    n.0.to_string().parse().ok()
}
pub(super) async fn fee(ledger: Principal) -> Result<u64> {
    let response = ic_cdk::call::Call::bounded_wait(ledger, "icrc1_fee")
        .change_timeout(60)
        .await
        .map_err(|_| Error::KeyService)?;
    let fee: Nat = response.candid().map_err(|_| Error::KeyService)?;
    nat(&fee).ok_or(Error::InvalidInput)
}

pub(super) async fn transfer_from(p: &Payment) -> Outcome {
    let arg = TransferFromArg {
        spender_subaccount: None,
        from: Account {
            owner: p.wallet,
            subaccount: None,
        },
        to: Account {
            owner: p.config.recipient,
            subaccount: None,
        },
        amount: p.request.amount_e8s.into(),
        fee: Some(p.fee.into()),
        memo: Some(p.memo.clone()),
        created_at_time: Some(p.created_at_time),
    };
    match ic_cdk::call::Call::bounded_wait(p.config.ledger, "icrc2_transfer_from")
        .change_timeout(60)
        .with_arg(arg)
        .await
    {
        Err(_) => Outcome::Unknown,
        Ok(response) => match response.candid::<std::result::Result<Nat, TransferError>>() {
            Ok(Ok(block))
            | Ok(Err(TransferError::Duplicate {
                duplicate_of: block,
            })) => nat(&block).map(Outcome::Paid).unwrap_or(Outcome::Unknown),
            Ok(Err(TransferError::BadFee { expected_fee })) => nat(&expected_fee)
                .map(|f| Outcome::Rejected(Status::BadFee(f)))
                .unwrap_or(Outcome::Unknown),
            Ok(Err(TransferError::InsufficientFunds { .. })) => {
                Outcome::Rejected(Status::InsufficientFunds)
            }
            Ok(Err(TransferError::InsufficientAllowance { .. })) => {
                Outcome::Rejected(Status::InsufficientAllowance)
            }
            // TooOld after an unknown first attempt does not prove the original transfer failed.
            Ok(Err(TransferError::TooOld)) => Outcome::Unknown,
            Ok(Err(_)) => Outcome::Rejected(Status::Rejected),
            Err(_) => Outcome::Unknown,
        },
    }
}

pub(super) fn require_ledger(ledger: Principal) -> Result<()> {
    if cfg!(feature = "synthetic-funding-test-only")
        || ledger
            == Principal::from_text("73mez-iiaaa-aaaaq-aaasq-cai").expect("KINIC ledger principal")
    {
        Ok(())
    } else {
        Err(Error::Unauthorized)
    }
}
