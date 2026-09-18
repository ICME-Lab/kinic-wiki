// Where: workers/wiki-generator/src/nns-actions.ts
// What: Exhaustive known-action registry and evidence requirements for NNS decisions.
// Why: New or opaque action types must fail closed instead of inheriting generic auto-voting.
import type { NnsEvidenceKind } from "./nns-policy.js";

export type ActionDefinition = {
  family: string;
  requiredEvidence: NnsEvidenceKind[];
  deterministicVerifications: string[];
  jevQuestions: string[];
  autoVoteSupported: boolean;
};

const JEV_QUESTIONS = [
  "recommendation", "description_matches_payload", "required_evidence_present",
  "material_claims_supported", "violates_policy", "material_unbounded_risk"
];

const DEFINITIONS: Record<string, ActionDefinition> = Object.fromEntries([
  ...actions("motion", true, ["proposal", "governance"], ["Motion"]),
  ...actions("governance", false, ["proposal", "governance"], ["RegisterKnownNeuron", "DeregisterKnownNeuron", "SetDefaultFollowees"]),
  ...actions("economics", false, ["proposal", "governance", "reference"], ["ManageNetworkEconomics", "NetworkEconomics", "UpdateNodeRewardsTable", "ClearProvisionalWhitelist"]),
  ...actions("sns", false, ["proposal", "governance", "reference"], ["CreateServiceNervousSystem", "OpenSnsTokenSwap", "SetSnsTokenSwapOpenTimeWindow"]),
  ...actions("canister", false, ["proposal", "governance", "reference"], ["InstallCode", "UpdateCanisterSettings", "StopOrStartCanister", "UninstallCode", "TakeCanisterSnapshot", "LoadCanisterSnapshot", "CreateCanisterAndInstallCode"]),
  ...actions("ic-os", false, ["proposal", "governance", "reference"], ["ReviseElectedGuestosVersions", "ReviseElectedHostosVersions", "DeployHostosToSomeNodes", "DeployGuestosToAllSubnetNodes", "DeployGuestosToSomeApiBoundaryNodes", "DeployGuestosToAllUnassignedNodes", "BlessAlternativeGuestOsVersion", "UpdateStandardEngineReplicaVersion"]),
  ...actions("subnet-registry", false, ["proposal", "governance", "reference"], ["CreateSubnet", "UpdateConfigOfSubnet", "AddNodeToSubnet", "RemoveNodesFromSubnet", "ChangeSubnetMembership", "RecoverSubnet", "SetFirewallConfig", "AddFirewallRules", "RemoveFirewallRules", "UpdateFirewallRules", "SetAuthorizedSubnetworks", "UpdateSubnetType", "ChangeSubnetTypeAssignment", "UpdateSnsWasmSnsSubnetIds", "RerouteCanisterRanges", "PrepareCanisterMigration", "CompleteCanisterMigration", "BitcoinSetConfig"]),
  ...actions("participants", false, ["proposal", "governance", "reference"], ["AddOrRemoveDataCenters", "AddOrRemoveNodeProvider", "AssignNoid", "UpdateNodeOperatorConfig", "RemoveNodeOperators", "RemoveNodes", "UpdateSshReadonlyAccessForAllUnassignedNodes", "ApproveGenesisKyc", "RewardNodeProvider", "RewardNodeProviders", "FulfillSubnetRentalRequest"]),
  ...actions("sns-wasm", false, ["proposal", "governance", "reference"], ["AddSnsWasm", "InsertSnsWasmUpgradePathEntries"]),
  ...actions("restricted", false, ["proposal", "governance"], ["ManageNeuron", "ExecuteNnsFunction"]),
  ...actions("legacy-nns-function", false, ["proposal", "governance", "reference"], [
    "NnsCanisterInstall", "NnsCanisterUpgrade", "NnsRootUpgrade", "IcpXdrConversionRate",
    "BlessReplicaVersion", "RetireReplicaVersion", "StopOrStartNnsCanister",
    "UpdateUnassignedNodesConfig", "UpdateAllowedPrincipals", "HardResetNnsRootToVersion",
    "AddApiBoundaryNodes", "RemoveApiBoundaryNodes", "UpdateApiBoundaryNodesVersion",
    "SubnetRentalRequest", "PauseCanisterMigrations", "UnpauseCanisterMigrations",
    "SetSubnetOperationalLevel", "SplitSubnet", "DeleteSubnet", "SetDefaultInitialDkgSubnet",
    "MergeSubnets", "UpdateElectedHostosVersions", "UpdateNodesHostosVersion"
  ])
] as [string, ActionDefinition][]);

export function actionDefinition(action: string): ActionDefinition | null {
  return DEFINITIONS[action] ?? DEFINITIONS[canonicalActionName(action)] ?? null;
}

function canonicalActionName(value: string): string {
  const stripped = value.replace(/^ACTION_/i, "");
  if (!stripped.includes("_") && /^[A-Za-z][A-Za-z0-9]*$/.test(stripped)) return stripped;
  return stripped.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}

export function knownNnsActions(): string[] {
  return Object.keys(DEFINITIONS).sort();
}

function actions(family: string, autoVoteSupported: boolean, requiredEvidence: NnsEvidenceKind[], names: string[]): [string, ActionDefinition][] {
  return names.map((name) => [name, {
    family,
    autoVoteSupported,
    requiredEvidence,
    deterministicVerifications: [
      "proposal_open", "before_deadline", "dashboard_matches_governance", "required_evidence_complete"
    ],
    jevQuestions: JEV_QUESTIONS
  }]);
}
