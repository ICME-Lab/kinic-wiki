// Where: extensions/wiki-clipper/src/runtime-config.js
// What: Build-time runtime targets for production and developer staging builds.
// Why: The staging extension must never inherit production canister or Worker endpoints.

const PRODUCTION_CANISTER_ID = "6emaw-iyaaa-aaaay-aacka-cai";
const PRODUCTION_DERIVATION_ORIGIN = `https://${PRODUCTION_CANISTER_ID}.icp0.io`;

export const RUNTIME_CANISTER_ID =
  typeof __KINIC_WIKI_CANISTER_ID__ === "string"
    ? __KINIC_WIKI_CANISTER_ID__
    : PRODUCTION_CANISTER_ID;
export const RUNTIME_IC_HOST =
  typeof __KINIC_WIKI_IC_HOST__ === "string" ? __KINIC_WIKI_IC_HOST__ : "https://icp0.io";
export const RUNTIME_DERIVATION_ORIGIN =
  typeof __KINIC_WIKI_DERIVATION_ORIGIN__ === "string"
    ? __KINIC_WIKI_DERIVATION_ORIGIN__
    : PRODUCTION_DERIVATION_ORIGIN;
export const RUNTIME_SOURCE_TRIGGER_URL =
  typeof __KINIC_WIKI_SOURCE_TRIGGER_URL__ === "string"
    ? __KINIC_WIKI_SOURCE_TRIGGER_URL__
    : "https://wiki.kinic.xyz/api/source/run";
export const RUNTIME_WIKI_ORIGIN =
  typeof __KINIC_WIKI_ORIGIN__ === "string" ? __KINIC_WIKI_ORIGIN__ : "https://wiki.kinic.xyz";
