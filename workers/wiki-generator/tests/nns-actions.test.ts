// Where: workers/wiki-generator/tests/nns-actions.test.ts
// What: Known NNS proposal-action registry coverage tests.
// Why: New action strings must fail closed while current direct actions remain classified.
import assert from "node:assert/strict";
import test from "node:test";
import { actionDefinition, knownNnsActions } from "../src/nns-actions.js";

const DIRECT_ACTIONS = [
  "ManageNeuron", "ManageNetworkEconomics", "Motion", "ApproveGenesisKyc",
  "AddOrRemoveNodeProvider", "RewardNodeProvider", "RewardNodeProviders",
  "SetDefaultFollowees", "RegisterKnownNeuron", "DeregisterKnownNeuron",
  "SetSnsTokenSwapOpenTimeWindow", "OpenSnsTokenSwap", "CreateServiceNervousSystem",
  "ExecuteNnsFunction", "InstallCode", "StopOrStartCanister", "UpdateCanisterSettings",
  "FulfillSubnetRentalRequest", "BlessAlternativeGuestOsVersion", "TakeCanisterSnapshot",
  "LoadCanisterSnapshot", "CreateCanisterAndInstallCode", "UpdateStandardEngineReplicaVersion"
];

const NNS_FUNCTION_ACTIONS = [
  "CreateSubnet", "AddNodeToSubnet", "NnsCanisterInstall", "NnsCanisterUpgrade",
  "BlessReplicaVersion", "RecoverSubnet", "UpdateConfigOfSubnet", "AssignNoid", "NnsRootUpgrade",
  "IcpXdrConversionRate", "DeployGuestosToAllSubnetNodes", "ClearProvisionalWhitelist",
  "RemoveNodesFromSubnet", "SetAuthorizedSubnetworks", "SetFirewallConfig", "UpdateNodeOperatorConfig",
  "StopOrStartNnsCanister", "RemoveNodes", "UninstallCode", "UpdateNodeRewardsTable",
  "AddOrRemoveDataCenters", "UpdateUnassignedNodesConfig", "RemoveNodeOperators", "RerouteCanisterRanges",
  "AddFirewallRules", "RemoveFirewallRules", "UpdateFirewallRules", "PrepareCanisterMigration",
  "CompleteCanisterMigration", "AddSnsWasm", "ChangeSubnetMembership", "UpdateSubnetType",
  "ChangeSubnetTypeAssignment", "UpdateSnsWasmSnsSubnetIds", "UpdateAllowedPrincipals",
  "RetireReplicaVersion", "InsertSnsWasmUpgradePathEntries", "ReviseElectedGuestosVersions",
  "BitcoinSetConfig", "UpdateElectedHostosVersions", "UpdateNodesHostosVersion",
  "HardResetNnsRootToVersion", "AddApiBoundaryNodes", "RemoveApiBoundaryNodes",
  "UpdateApiBoundaryNodesVersion", "DeployGuestosToSomeApiBoundaryNodes",
  "DeployGuestosToAllUnassignedNodes", "UpdateSshReadonlyAccessForAllUnassignedNodes",
  "ReviseElectedHostosVersions", "DeployHostosToSomeNodes", "SubnetRentalRequest",
  "PauseCanisterMigrations", "UnpauseCanisterMigrations", "SetSubnetOperationalLevel", "SplitSubnet",
  "DeleteSubnet", "SetDefaultInitialDkgSubnet", "MergeSubnets"
];

test("all current direct Governance actions are registered", () => {
  for (const action of DIRECT_ACTIONS) assert.ok(actionDefinition(action), action);
  assert.ok(knownNnsActions().length >= DIRECT_ACTIONS.length);
  assert.equal(actionDefinition("Motion")?.autoVoteSupported, true);
  assert.equal(actionDefinition("ManageNetworkEconomics")?.autoVoteSupported, false);
});

test("all current non-reserved ExecuteNnsFunction values are registered", () => {
  for (const action of NNS_FUNCTION_ACTIONS) assert.ok(actionDefinition(action), action);
});

test("stable ACTION_* names normalize while unknown actions stay unsupported", () => {
  assert.ok(actionDefinition("ACTION_MANAGE_NETWORK_ECONOMICS"));
  assert.equal(actionDefinition("ACTION_FUTURE_UNREVIEWED_CHANGE"), null);
});
