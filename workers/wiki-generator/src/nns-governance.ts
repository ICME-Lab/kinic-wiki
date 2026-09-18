// Where: workers/wiki-generator/src/nns-governance.ts
// What: Minimal NNS Governance query and RegisterVote client.
// Why: Dashboard data is useful evidence, but signed votes require an authoritative preflight.
import { Actor, HttpAgent } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { identityFromPem } from "./identity-pem.js";

export const NNS_GOVERNANCE_CANISTER_ID = "rrkah-fqaaa-aaaaa-aaaaq-cai";
export const NNS_PROPOSAL_STATUS_OPEN = 1;
export const NNS_VOTE_YES = 1;
export const NNS_VOTE_NO = 2;

type Variant = Record<string, unknown>;
type RawProposalId = { id: bigint };
type RawSelfValue = Variant;
type RawSelfAction = { type_name: [] | [string]; type_description: [] | [string]; value: [] | [RawSelfValue] };
type RawProposal = {
  title: [] | [string];
  summary: string;
  url: string;
  self_describing_action: [] | [RawSelfAction];
};
type RawBallot = { vote: number; voting_power: bigint };
type RawProposalInfo = {
  id: [] | [RawProposalId];
  status: number;
  topic: number;
  deadline_timestamp_seconds: [] | [bigint];
  proposal: [] | [RawProposal];
  ballots?: [bigint, RawBallot][];
};
type RawBallotInfo = { vote: number; proposal_id: [] | [RawProposalId] };
type RawNeuron = { id: [] | [RawProposalId]; recent_ballots: RawBallotInfo[]; hot_keys: Principal[]; controller: [] | [Principal] };
type GovernanceError = { error_message: string; error_type: number };
type FullNeuronResult = { Ok: RawNeuron } | { Err: GovernanceError };
type ManageResponse = { command: [] | [({ RegisterVote: null } | { Error: GovernanceError })] };
type NeuronSelector = { NeuronId: RawProposalId };
type ManageRequest = {
  id: [];
  neuron_id_or_subaccount: [NeuronSelector];
  command: [{ RegisterVote: { vote: number; proposal: [RawProposalId] } }];
};

type GovernanceActor = {
  get_pending_proposals: (request: [{ return_self_describing_action: [boolean] }]) => Promise<RawProposalInfo[]>;
  get_proposal_info: (proposalId: bigint) => Promise<[] | [RawProposalInfo]>;
  get_full_neuron: (neuronId: bigint) => Promise<FullNeuronResult>;
  simulate_manage_neuron: (request: ManageRequest) => Promise<ManageResponse>;
  manage_neuron: (request: ManageRequest) => Promise<ManageResponse>;
};

export type GovernanceProposalSnapshot = {
  proposalId: string;
  status: number;
  topic: number;
  deadlineTimestampSeconds: string | null;
  title: string;
  summary: string;
  url: string;
  action: string | null;
  actionDescription: string | null;
  actionValue: unknown;
  ballots: Record<string, { vote: number; votingPower: string }>;
  capturedAt: string;
};

export type GovernanceNeuronSnapshot = {
  neuronId: string;
  authorized: boolean;
  existingVote: "YES" | "NO" | null;
};

export interface NnsGovernanceClient {
  getPendingProposal(proposalId: bigint): Promise<GovernanceProposalSnapshot | null>;
  getProposal(proposalId: bigint): Promise<GovernanceProposalSnapshot | null>;
  getNeuron(neuronId: bigint, proposalId: bigint): Promise<GovernanceNeuronSnapshot>;
  simulateVote(neuronId: bigint, proposalId: bigint, vote: "YES" | "NO"): Promise<void>;
  registerVote(neuronId: bigint, proposalId: bigint, vote: "YES" | "NO"): Promise<void>;
}

export async function createNnsGovernanceClient(host: string, identityPem?: string): Promise<NnsGovernanceClient> {
  const identity = identityPem ? identityFromPem(identityPem) : undefined;
  const agent = HttpAgent.createSync({ host, identity });
  if (isLocalHost(host)) await agent.fetchRootKey();
  const actor = Actor.createActor<GovernanceActor>(governanceIdlFactory(Boolean(identityPem)), {
    agent,
    canisterId: Principal.fromText(NNS_GOVERNANCE_CANISTER_ID)
  });
  const caller = identity?.getPrincipal().toText() ?? null;
  return {
    async getPendingProposal(proposalId) {
      const proposals = await actor.get_pending_proposals([{ return_self_describing_action: [true] }]);
      const found = proposals.find((proposal) => proposal.id[0]?.id === proposalId);
      return found ? normalizeProposal(found) : null;
    },
    async getProposal(proposalId) {
      const found = (await actor.get_proposal_info(proposalId))[0];
      return found ? normalizeProposal(found) : null;
    },
    async getNeuron(neuronId, proposalId) {
      const result = await actor.get_full_neuron(neuronId);
      if ("Err" in result) throw new Error(`NNS neuron query failed: ${result.Err.error_type}`);
      const neuron = result.Ok;
      const authorized = caller !== null
        && (neuron.controller[0]?.toText() === caller || neuron.hot_keys.some((principal) => principal.toText() === caller));
      const ballot = neuron.recent_ballots.find((entry) => entry.proposal_id[0]?.id === proposalId);
      return {
        neuronId: neuronId.toString(),
        authorized,
        existingVote: ballot?.vote === NNS_VOTE_YES ? "YES" : ballot?.vote === NNS_VOTE_NO ? "NO" : null
      };
    },
    async simulateVote(neuronId, proposalId, vote) {
      unwrapRegisterVote(await actor.simulate_manage_neuron(voteRequest(neuronId, proposalId, vote)));
    },
    async registerVote(neuronId, proposalId, vote) {
      unwrapRegisterVote(await actor.manage_neuron(voteRequest(neuronId, proposalId, vote)));
    }
  };
}

export function dashboardMatchesGovernance(
  dashboard: { proposalId: number; action: string; topic: string; summary: string; rawRecord?: Record<string, unknown> },
  governance: GovernanceProposalSnapshot
): boolean {
  if (governance.proposalId !== String(dashboard.proposalId)) return false;
  const dashboardAction = normalizedAction(dashboard.action);
  const governanceAction = normalizedAction(governance.action ?? "");
  if (!dashboardAction || !governanceAction || dashboardAction !== governanceAction) return false;
  const governanceTopic = TOPICS[governance.topic];
  if (!governanceTopic || normalized(dashboard.topic).replace(/^topic/, "") !== normalized(governanceTopic)) return false;
  if (dashboard.summary.trim() && governance.summary.trim() && dashboard.summary.trim() !== governance.summary.trim()) return false;
  const dashboardPayload = dashboard.rawRecord?.payload;
  if (dashboardPayload !== undefined && governance.actionValue !== null
      && canonicalComparable(dashboardPayload) !== canonicalComparable(governance.actionValue)) return false;
  return true;
}

function normalizeProposal(value: RawProposalInfo): GovernanceProposalSnapshot {
  const id = value.id[0]?.id;
  if (id === undefined) throw new Error("NNS proposal response is missing id");
  const proposal = value.proposal[0];
  if (!proposal) throw new Error("NNS proposal response is missing proposal");
  const action = proposal.self_describing_action[0];
  return {
    proposalId: id.toString(),
    status: value.status,
    topic: value.topic,
    deadlineTimestampSeconds: value.deadline_timestamp_seconds[0]?.toString() ?? null,
    title: proposal.title[0] ?? `NNS Proposal ${id.toString()}`,
    summary: proposal.summary,
    url: proposal.url,
    action: action?.type_name[0] ?? null,
    actionDescription: action?.type_description[0] ?? null,
    actionValue: action?.value[0] ? normalizeSelfValue(action.value[0]) : null,
    ballots: Object.fromEntries((value.ballots ?? []).map(([neuronId, ballot]) => [neuronId.toString(), {
      vote: ballot.vote,
      votingPower: ballot.voting_power.toString()
    }])),
    capturedAt: new Date().toISOString()
  };
}

function normalizeSelfValue(value: RawSelfValue): unknown {
  if ("Null" in value) return null;
  if ("Text" in value || "Bool" in value || "Nat" in value || "Int" in value) {
    const raw = (value.Text ?? value.Bool ?? value.Nat ?? value.Int) as unknown;
    return typeof raw === "bigint" ? raw.toString() : raw;
  }
  if ("Blob" in value) return bytesToHex(value.Blob as Uint8Array);
  if ("Array" in value) return (value.Array as RawSelfValue[]).map(normalizeSelfValue);
  if ("Map" in value) return Object.fromEntries((value.Map as [string, RawSelfValue][]).map(([key, entry]) => [key, normalizeSelfValue(entry)]));
  return null;
}

function voteRequest(neuronId: bigint, proposalId: bigint, vote: "YES" | "NO"): ManageRequest {
  return {
    id: [],
    neuron_id_or_subaccount: [{ NeuronId: { id: neuronId } }],
    command: [{ RegisterVote: { vote: vote === "YES" ? NNS_VOTE_YES : NNS_VOTE_NO, proposal: [{ id: proposalId }] } }]
  };
}

function unwrapRegisterVote(response: ManageResponse): void {
  const command = response.command[0];
  if (!command) throw new Error("NNS vote response is missing command");
  if ("Error" in command) throw new Error(`NNS vote failed: ${command.Error.error_type}`);
  if (!("RegisterVote" in command)) throw new Error("NNS vote response has an unexpected command");
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizedAction(value: string): string {
  return normalized(value).replace(/^action/, "");
}

function canonicalComparable(value: unknown): string {
  if (typeof value === "bigint") return `#integer:${value.toString()}`;
  if (typeof value === "number" && Number.isSafeInteger(value)) return `#integer:${value}`;
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return `#integer:${BigInt(value).toString()}`;
  if (Array.isArray(value)) return `[${value.map(canonicalComparable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalComparable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const TOPICS: Record<number, string> = {
  0: "Unspecified", 1: "NeuronManagement", 2: "ExchangeRate", 3: "NetworkEconomics",
  4: "Governance", 5: "NodeAdmin", 6: "ParticipantManagement", 7: "SubnetManagement",
  8: "ApplicationCanisterManagement", 9: "Kyc", 10: "NodeProviderRewards",
  12: "IcOsVersionDeployment", 13: "IcOsVersionElection", 14: "SnsAndCommunityFund",
  15: "ApiBoundaryNodeManagement", 16: "SubnetRental", 17: "ProtocolCanisterManagement",
  18: "ServiceNervousSystemManagement"
};

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isLocalHost(host: string): boolean {
  const hostname = new URL(host).hostname;
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function governanceIdlFactory(includeBallots: boolean): Parameters<typeof Actor.createActor>[0] {
  return ({ IDL: idl }) => {
  const ProposalId = idl.Record({ id: idl.Nat64 });
  const SelfValue = idl.Rec();
  SelfValue.fill(idl.Variant({
    Blob: idl.Vec(idl.Nat8), Text: idl.Text, Bool: idl.Bool, Nat: idl.Nat, Int: idl.Int,
    Array: idl.Vec(SelfValue), Map: idl.Vec(idl.Tuple(idl.Text, SelfValue)), Null: idl.Null
  }));
  const SelfAction = idl.Record({
    type_name: idl.Opt(idl.Text), type_description: idl.Opt(idl.Text), value: idl.Opt(SelfValue)
  });
  const Proposal = idl.Record({
    title: idl.Opt(idl.Text), summary: idl.Text, url: idl.Text, self_describing_action: idl.Opt(SelfAction)
  });
  const Ballot = idl.Record({ vote: idl.Int32, voting_power: idl.Nat64 });
  const proposalInfoFields = {
    id: idl.Opt(ProposalId), status: idl.Int32, topic: idl.Int32,
    deadline_timestamp_seconds: idl.Opt(idl.Nat64), proposal: idl.Opt(Proposal)
  };
  const ProposalInfo = idl.Record(includeBallots
    ? { ...proposalInfoFields, ballots: idl.Vec(idl.Tuple(idl.Nat64, Ballot)) }
    : proposalInfoFields);
  const Error = idl.Record({ error_message: idl.Text, error_type: idl.Int32 });
  const BallotInfo = idl.Record({ vote: idl.Int32, proposal_id: idl.Opt(ProposalId) });
  const Neuron = idl.Record({
    id: idl.Opt(ProposalId), recent_ballots: idl.Vec(BallotInfo), hot_keys: idl.Vec(idl.Principal), controller: idl.Opt(idl.Principal)
  });
  const FullNeuronResult = idl.Variant({ Ok: Neuron, Err: Error });
  const Selector = idl.Variant({ NeuronId: ProposalId, Subaccount: idl.Vec(idl.Nat8) });
  const RegisterVote = idl.Record({ vote: idl.Int32, proposal: idl.Opt(ProposalId) });
  const CommandRequest = idl.Variant({ RegisterVote });
  const ManageRequest = idl.Record({ id: idl.Opt(ProposalId), neuron_id_or_subaccount: idl.Opt(Selector), command: idl.Opt(CommandRequest) });
  const CommandResponse = idl.Variant({ RegisterVote: idl.Record({}), Error });
  const ManageResponse = idl.Record({ command: idl.Opt(CommandResponse) });
  const PendingRequest = idl.Record({ return_self_describing_action: idl.Opt(idl.Bool) });
  return idl.Service({
    get_pending_proposals: idl.Func([idl.Opt(PendingRequest)], [idl.Vec(ProposalInfo)], ["query"]),
    get_proposal_info: idl.Func([idl.Nat64], [idl.Opt(ProposalInfo)], ["query"]),
    get_full_neuron: idl.Func([idl.Nat64], [FullNeuronResult], ["query"]),
    simulate_manage_neuron: idl.Func([ManageRequest], [ManageResponse], []),
    manage_neuron: idl.Func([ManageRequest], [ManageResponse], [])
  });
  };
}
