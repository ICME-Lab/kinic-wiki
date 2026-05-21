// Where: crates/vfs_canister/src/icp_cli_login.js
// What: Browser entrypoint for the canister-hosted ICP CLI login page.
// Why: The generated HTML must be self-contained while sharing II auth helpers.
import { AuthClient } from "@icp-sdk/auth/client";
import { DelegationChain, DelegationIdentity } from "@icp-sdk/core/identity";
import {
  CLI_DELEGATION_TTL_MS,
  CLI_DELEGATION_TTL_NS,
  authClientCreateOptions,
  decodeBase64UrlToBytes,
  derivationOriginForLocation,
  identityProviderUrlForLocation,
  parseCliLoginHash
} from "../../../shared/ii-auth/index.js";

const status = document.querySelector("#status");
const error = document.querySelector("#error");
const button = document.querySelector("#login");
const requestDetails = document.querySelector("#request-details");
const callbackHostPort = document.querySelector("#callback-host-port");
const derivationOrigin = document.querySelector("#derivation-origin");
const delegationTtl = document.querySelector("#delegation-ttl");
const request = parseCliLoginHash(location.hash);
let authClient = null;

if (!request) {
  fail("Invalid CLI login request.");
} else {
  renderRequestDetails(request);
  history.replaceState(null, "", location.pathname);
  AuthClient.create(authClientCreateOptions(CLI_DELEGATION_TTL_MS))
    .then((client) => {
      authClient = client;
      button.disabled = false;
      status.textContent = "Continue to authorize this local CLI session.";
    })
    .catch((cause) => fail(errorMessage(cause)));
}

button.addEventListener("click", async () => {
  if (!authClient || !request) return;
  button.disabled = true;
  status.textContent = "Waiting for Internet Identity.";
  await authClient.login({
    identityProvider: identityProviderUrlForLocation(location),
    derivationOrigin: derivationOriginForLocation(location),
    maxTimeToLive: CLI_DELEGATION_TTL_NS,
    onSuccess: () => void postDelegation(authClient, request),
    onError: (cause) => fail(errorMessage(cause))
  });
});

function renderRequestDetails(nextRequest) {
  const callback = new URL(nextRequest.callback);
  callbackHostPort.textContent = callback.port
    ? `${callback.hostname}:${callback.port}`
    : callback.hostname;
  derivationOrigin.textContent = derivationOriginForLocation(location);
  delegationTtl.textContent = formatDuration(CLI_DELEGATION_TTL_MS);
  requestDetails.hidden = false;
}

function formatDuration(milliseconds) {
  const hours = milliseconds / (60 * 60 * 1000);
  if (Number.isInteger(hours)) {
    return `${hours} hours`;
  }
  return `${Math.round(milliseconds / 60_000)} minutes`;
}

async function postDelegation(client, nextRequest) {
  try {
    status.textContent = "Sending the delegation to the local CLI.";
    const identity = client.getIdentity();
    if (!(identity instanceof DelegationIdentity)) {
      throw new Error("Internet Identity delegation was not available.");
    }
    const sessionPublicKey = decodeBase64UrlToBytes(nextRequest.publicKey);
    const chain = await DelegationChain.create(
      identity,
      {
        toDer() {
          return sessionPublicKey;
        }
      },
      new Date(Date.now() + CLI_DELEGATION_TTL_MS),
      { previous: identity.getDelegation() }
    );
    const response = await fetch(nextRequest.callback, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chain.toJSON()),
      redirect: "error"
    });
    if (!response.ok) {
      throw new Error(`CLI callback failed with HTTP ${response.status}.`);
    }
    await client.logout();
    status.textContent = "CLI login complete.";
    setTimeout(() => window.close(), 1000);
  } catch (cause) {
    fail(errorMessage(cause));
  }
}

function fail(message) {
  status.textContent = "CLI login failed.";
  error.hidden = false;
  error.textContent = message;
  button.disabled = true;
}

function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
