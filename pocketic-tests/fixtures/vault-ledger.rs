//! Synthetic ledger only. Never deployed outside PocketIC.
use candid::{CandidType, Nat, Principal};
use serde::Deserialize;
use std::cell::{Cell, RefCell};
#[derive(Clone, CandidType, Deserialize)]
struct Account { owner: Principal, subaccount: Option<Vec<u8>> }
#[derive(Clone, CandidType, Deserialize)]
struct Transfer { spender_subaccount: Option<Vec<u8>>, from: Account, to: Account, amount: Nat, fee: Option<Nat>, memo: Option<Vec<u8>>, created_at_time: Option<u64> }
#[derive(CandidType, Deserialize)]
enum TransferError { BadFee { expected_fee: Nat }, InsufficientFunds { balance: Nat }, InsufficientAllowance { allowance: Nat }, Duplicate { duplicate_of: Nat } }
thread_local! {static MODE: Cell<u8> = const {Cell::new(0)}; static FEE:Cell<u64>=const{Cell::new(10)};static CALLS:RefCell<Vec<Transfer>>=const{RefCell::new(Vec::new())};}
#[ic_cdk::update]
fn configure(mode:u8,fee:u64){assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));MODE.set(mode);FEE.set(fee);}
#[ic_cdk::update]
fn icrc1_fee()->Nat{FEE.get().into()}
#[ic_cdk::update]
fn icrc2_transfer_from(arg:Transfer)->Result<Nat,TransferError>{
 CALLS.with(|calls|{let mut calls=calls.borrow_mut();assert!(calls.len()<64);calls.push(arg);});
 match MODE.get(){
  1=>Err(TransferError::BadFee{expected_fee:FEE.get().into()}),
  2=>Err(TransferError::InsufficientAllowance{allowance:0u64.into()}),
  3=>Err(TransferError::InsufficientFunds{balance:0u64.into()}),
  4=>Err(TransferError::Duplicate{duplicate_of:100u64.into()}),
  // Committed synthetic response cannot be represented by the production receipt;
  // drives the exact same durable Unknown branch as an undecodable/ambiguous reply.
  6=>Ok(Nat::from(u128::MAX)),
  _=>Ok(100u64.into())
 }
}
#[ic_cdk::query]
fn calls()->Vec<Transfer>{CALLS.with(|calls|calls.borrow().clone())}
