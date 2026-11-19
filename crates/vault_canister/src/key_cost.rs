//! Actual vetKD fee accounting for the pinned CDK's local versus submitted outcomes.
use ic_cdk_management_canister::SignCallError;

pub(crate) fn actual_payment<T>(
    attached: u64,
    result: &Result<T, SignCallError>,
    refunded: impl FnOnce() -> u128,
) -> u64 {
    use ic_cdk::call::CallFailed;
    match result {
        Err(
            SignCallError::SignCostError(_)
            | SignCallError::CallFailed(
                CallFailed::InsufficientLiquidCycleBalance(_) | CallFailed::CallPerformFailed(_),
            ),
        ) => 0,
        Ok(_)
        | Err(
            SignCallError::CallFailed(CallFailed::CallRejected(_))
            | SignCallError::CandidDecodeFailed(_),
        ) => attached.saturating_sub(u64::try_from(refunded()).unwrap_or(u64::MAX)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ic_cdk::{
        api::SignCostError,
        call::{CallFailed, CallPerformFailed, CallRejected, InsufficientLiquidCycleBalance},
    };
    #[test]
    fn local_nosend_errors_never_read_callback_refunds() {
        let local = [
            SignCallError::SignCostError(SignCostError::InvalidKeyName),
            SignCallError::SignCostError(SignCostError::InvalidCurveOrAlgorithm),
            SignCallError::SignCostError(SignCostError::UnrecognizedError(17)),
            SignCallError::CallFailed(CallFailed::InsufficientLiquidCycleBalance(
                InsufficientLiquidCycleBalance {
                    available: 1,
                    required: 30_000_000_000,
                },
            )),
            SignCallError::CallFailed(CallFailed::CallPerformFailed(CallPerformFailed)),
        ];
        for error in local {
            assert_eq!(
                actual_payment(30_000_000_000, &Err::<(), _>(error), || panic!(
                    "no reply exists; refund API is not evidence"
                )),
                0
            );
        }
    }
    #[test]
    fn submitted_reply_and_rejection_charge_only_the_unreturned_fee() {
        for result in [
            Ok(()),
            Err(SignCallError::CallFailed(CallFailed::CallRejected(
                CallRejected::with_rejection(5, "synthetic failure".into()),
            ))),
        ] {
            assert_eq!(
                actual_payment(30_000_000_000, &result, || 0),
                30_000_000_000
            );
            assert_eq!(
                actual_payment(30_000_000_000, &result, || 10_000_000_000),
                20_000_000_000
            );
            assert_eq!(
                actual_payment(30_000_000_000, &result, || 30_000_000_000),
                0
            );
            assert_eq!(actual_payment(30_000_000_000, &result, || u128::MAX), 0);
        }
    }
}
