export type ApiErrorCode =
  | "canister_not_found"
  | "database_not_found"
  | "ic_host_unreachable"
  | "wiki_api_version_mismatch"
  | "wiki_api_missing"
  | "invalid_canister_id"
  | "node_not_found"
  | "path_not_found"
  | "wiki_request_failed";

export type PublicApiError = {
  error: string;
  hint: string;
  code: ApiErrorCode;
  status?: number;
};

export function invalidCanisterIdError(reason: string): PublicApiError {
  return {
    error: "Invalid canister ID",
    hint: `Check the URL canister segment. ${reason}`,
    code: "invalid_canister_id"
  };
}

export function classifyApiError(error: unknown, host: string): PublicApiError {
  const raw = errorMessage(error);
  const local = isLocalReplicaHost(host);
  if (/Canister\s+[\w-]+\s+not found/i.test(raw) || /IC0301/i.test(raw)) {
    return {
      error: "Canister not found on this IC host",
      hint: local
        ? "Check that the local replica is running, the icp local network state matches this canister ID, and the wiki canister has been deployed."
        : "Check the canister ID and confirm that the target canister exists on this IC host.",
      code: "canister_not_found"
    };
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|network/i.test(raw)) {
    return {
      error: "Cannot reach IC host",
      hint: local
        ? "Check that the local replica or icp local network is running and that VITE_WIKI_IC_HOST points to it."
        : "Check VITE_WIKI_IC_HOST and network connectivity to the IC gateway.",
      code: "ic_host_unreachable"
    };
  }
  if (/CandidDecodeError|Cannot find field hash|subtype|type mismatch|variant, expected fields/i.test(raw)) {
    return {
      error: "Wiki VFS API response unavailable.",
      hint: "The canister response could not be decoded by the browser.",
      code: "wiki_api_version_mismatch"
    };
  }
  if (/method .*not found|no (query|update) method|does not expose|Cannot find field|subtype|type mismatch|Candid|IDL/i.test(raw)) {
    return {
      error: "This canister does not expose the Wiki VFS API",
      hint: "Use a Kinic Wiki canister with read_node_context, list_children, graph_neighborhood, and search methods.",
      code: "wiki_api_missing"
    };
  }
  return {
    error: "Wiki request failed",
    hint: local
      ? "Check the local replica logs and confirm the wiki canister is healthy."
      : "Check the canister ID, gateway host, and public Wiki VFS API availability.",
    code: "wiki_request_failed"
  };
}

export function classifyCanisterError(message: string): PublicApiError {
  if (/\bdatabase not found:/i.test(message)) {
    return {
      error: "Database not found",
      hint: "Open the dashboard and select a readable database.",
      code: "database_not_found",
      status: 404
    };
  }
  if (/^node not found:/i.test(message)) {
    return {
      error: message,
      hint: "Check the wiki path or search for the node.",
      code: "node_not_found",
      status: 404
    };
  }
  if (/^path not found:/i.test(message)) {
    return {
      error: message,
      hint: "Check the folder path or open a parent folder.",
      code: "path_not_found",
      status: 404
    };
  }
  return {
    error: message,
    hint: "The wiki canister rejected this request.",
    code: "wiki_request_failed",
    status: 400
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
import { isLocalReplicaHost } from "@kinic/vfs-client-core";
