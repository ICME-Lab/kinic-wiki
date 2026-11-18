import type { IcrcCallCanisterRequestParams, IcrcCallCanisterResult } from "@dfinity/oisy-wallet-signer";
import { base64ToUint8Array } from "@dfinity/utils";
import { Certificate, Cbor, HttpAgent, lookupResultToBuffer, requestIdOf } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { PaymentFailure } from "../errors";
import { configuredLoopback } from "./common";

function matches(value: unknown, expected: Uint8Array) {
  return value instanceof Uint8Array && value.length === expected.length && value.every((byte, index) => byte === expected[index]);
}
export async function certifiedReply(host: string, request: IcrcCallCanisterRequestParams, result: IcrcCallCanisterResult): Promise<Uint8Array> {
  try {
    const content = Cbor.decode<Record<string, unknown>>(base64ToUint8Array(result.contentMap));
    const canisterId = Principal.fromText(request.canisterId);
    if (content.request_type !== "call" || content.method_name !== request.method ||
        !matches(content.canister_id, canisterId.toUint8Array()) ||
        !matches(content.sender, Principal.fromText(request.sender).toUint8Array()) ||
        !matches(content.arg, base64ToUint8Array(request.arg)) ||
        !request.nonce || !matches(content.nonce, base64ToUint8Array(request.nonce))) throw new PaymentFailure("InvalidReply");
    const agent = HttpAgent.createSync({ host });
    const rootKey = configuredLoopback(host) ? await agent.fetchRootKey() : agent.rootKey;
    if (!rootKey) throw new PaymentFailure("InvalidReply");
    const certificate = await Certificate.create({
      certificate: base64ToUint8Array(result.certificate), rootKey, principal: { canisterId },
    });
    const reply = lookupResultToBuffer(certificate.lookup_path([new TextEncoder().encode("request_status"), requestIdOf(content), "reply"]));
    if (!reply) throw new PaymentFailure("InvalidReply");
    return reply;
  } catch { throw new PaymentFailure("InvalidReply"); }
}
