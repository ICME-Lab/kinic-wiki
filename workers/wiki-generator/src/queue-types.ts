// Where: workers/wiki-generator/src/queue-types.ts
// What: Queue execution context and application-level delivery outcomes shared by both Workers.
// Why: Queue retry semantics are common without coupling the NNS Worker to wiki generation logic.
export type QueueDisposition =
  | { kind: "ack" }
  | { kind: "retry"; delaySeconds: number; code: string; message: string }
  | { kind: "reschedule"; delaySeconds: number; code: string; message: string }
  | { kind: "dead_letter"; code: string; message: string };

export type QueueExecution = {
  leaseOwner: string;
  attempts: number;
};
