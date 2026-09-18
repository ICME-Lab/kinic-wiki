// Where: workers/wiki-generator/src/nns-voter-env.ts
// What: Isolated binding contract for the NNS voting Worker.
// Why: The neuron hotkey must not be available to the proposal-review Worker.
export type NnsVoterEnv = Omit<
  NnsVoterBindings,
  | "NNS_VOTE_DLQ"
  | "NNS_PROPOSAL_REVIEW_QUEUE"
  | "KINIC_NNS_AUTOVOTE_ENABLED"
  | "KINIC_NNS_VOTER_NEURON_ID"
  | "KINIC_NNS_AUDIT_DATABASE_ID"
  | "KINIC_WIKI_CANISTER_ID"
  | "KINIC_WIKI_IC_HOST"
> & {
  NNS_VOTE_DLQ: Queue<{ proposalId?: string; neuronId?: string; errorCode: string; failedAt: string }>;
  NNS_PROPOSAL_REVIEW_QUEUE: Queue<import("./types.js").NnsProposalReviewQueueMessage>;
  KINIC_NNS_AUTOVOTE_ENABLED?: string;
  KINIC_NNS_VOTER_NEURON_ID?: string;
  KINIC_NNS_VOTER_IDENTITY_PEM: string;
  KINIC_NNS_VOTER_WIKI_IDENTITY_PEM: string;
  KINIC_NNS_AUDIT_DATABASE_ID?: string;
  KINIC_WIKI_CANISTER_ID: string;
  KINIC_WIKI_IC_HOST?: string;
};
