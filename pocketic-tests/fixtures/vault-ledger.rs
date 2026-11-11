//! Synthetic ledger only. Only PocketIC or an isolated local acceptance network; never production.
use candid::{CandidType, Nat, Principal};
use serde::Deserialize;
use std::cell::{Cell, RefCell};
#[derive(Clone, CandidType, Deserialize)]
struct Account { owner: Principal, subaccount: Option<Vec<u8>> }
#[derive(Clone, CandidType, Deserialize)]
struct Transfer { spender_subaccount: Option<Vec<u8>>, from: Account, to: Account, amount: Nat, fee: Option<Nat>, memo: Option<Vec<u8>>, created_at_time: Option<u64> }
#[derive(CandidType, Deserialize)]
enum TransferError { BadFee { expected_fee: Nat }, InsufficientFunds { balance: Nat }, InsufficientAllowance { allowance: Nat }, Duplicate { duplicate_of: Nat }, GenericError { error_code: Nat, message: String } }
thread_local! {static FEE_DELAY:Cell<bool>=const{Cell::new(false)};static FEE_INVALID:Cell<bool>=const{Cell::new(false)};static FEE_CALLS:Cell<u64>=const{Cell::new(0)};static MODE: Cell<u8> = const {Cell::new(0)}; static FEE:Cell<u64>=const{Cell::new(10)};static CALLS:RefCell<Vec<Transfer>>=const{RefCell::new(Vec::new())};}
#[ic_cdk::update]
fn configure(mode:u8,fee:u64){assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));MODE.set(mode);FEE.set(fee);}
#[ic_cdk::update]
async fn icrc1_fee()->Nat{
 let number=FEE_CALLS.get()+1;FEE_CALLS.set(number);
 if FEE_DELAY.get(){
  ic_cdk::call::Call::unbounded_wait(Principal::management_canister(),"http_request").with_arg(HttpArgs{url:format!("https://vault-fee.invalid/{number}"),max_response_bytes:Some(1000),method:HttpMethod::get,headers:vec![],body:None}).with_cycles(30_000_000_000).await.expect("test must release fee lookup");
 }
 if FEE_INVALID.get(){Nat::from(u128::MAX)}else{FEE.get().into()}
}
#[ic_cdk::update]
fn fee_behavior(delay:bool,invalid:bool){assert!(ic_cdk::api::is_controller(&ic_cdk::api::msg_caller()));FEE_DELAY.set(delay);FEE_INVALID.set(invalid);}
#[ic_cdk::query]
fn fee_calls()->u64{FEE_CALLS.get()}
#[derive(CandidType)]
struct HttpArgs{url:String,max_response_bytes:Option<u64>,method:HttpMethod,headers:Vec<Header>,body:Option<Vec<u8>>}
#[derive(CandidType)]
#[allow(non_camel_case_types)]
enum HttpMethod{get}
#[derive(CandidType)]
struct Header{name:String,value:String}
#[ic_cdk::update]
async fn icrc2_transfer_from(arg:Transfer)->Result<Nat,TransferError>{
 let mode=MODE.get();
 CALLS.with(|calls|{let mut calls=calls.borrow_mut();assert!(calls.len()<64);calls.push(arg);});
 if mode==8 {
   let number=CALLS.with(|calls|calls.borrow().len());
   ic_cdk::call::Call::unbounded_wait(Principal::management_canister(),"http_request").with_arg(HttpArgs{url:format!("https://vault-transfer.invalid/{number}"),max_response_bytes:Some(1000),method:HttpMethod::get,headers:vec![],body:None}).with_cycles(30_000_000_000).await.expect("test must release transfer");
 }
 match mode{
  1=>Err(TransferError::BadFee{expected_fee:FEE.get().into()}),
  2=>Err(TransferError::InsufficientAllowance{allowance:0u64.into()}),
  3=>Err(TransferError::InsufficientFunds{balance:0u64.into()}),
  4=>Err(TransferError::Duplicate{duplicate_of:100u64.into()}),
  // Committed synthetic response cannot be represented by the production receipt;
  // drives the exact same durable Unknown branch as an undecodable/ambiguous reply.
  6=>Ok(Nat::from(u128::MAX)),
  7=>Err(TransferError::GenericError{error_code:1u64.into(),message:"台帳エラー".repeat(16384)}),
  _=>Ok(100u64.into())
 }
}
#[ic_cdk::query]
fn calls()->Vec<Transfer>{CALLS.with(|calls|calls.borrow().clone())}

// Browser acceptance exercises the real ICRC-2 approval round trip. This fixture
// records synthetic approvals; it is not a ledger implementation or balance proof.
#[derive(Clone, CandidType, Deserialize)]
struct Approval { from_subaccount:Option<Vec<u8>>, spender:Account, amount:Nat, expected_allowance:Option<Nat>, expires_at:Option<u64>, fee:Option<Nat>, memo:Option<Vec<u8>>, created_at_time:Option<u64> }
thread_local! {static APPROVALS:RefCell<Vec<(Principal,Approval)>>=const{RefCell::new(Vec::new())};}
#[ic_cdk::update]
fn icrc2_approve(arg:Approval)->Result<Nat,TransferError>{
 let caller=ic_cdk::api::msg_caller();assert_ne!(caller,Principal::anonymous());
 APPROVALS.with(|rows|{let mut rows=rows.borrow_mut();assert!(rows.len()<64);rows.push((caller,arg));Ok(Nat::from(rows.len() as u64))})
}
#[ic_cdk::query]
fn approvals()->Vec<(Principal,Approval)>{APPROVALS.with(|rows|rows.borrow().clone())}

#[ic_cdk::query]
fn icrc1_balance_of(_account:Account)->Nat{Nat::from(1_000_000_000u64)}
