import { isUtf8 } from "node:buffer";
import { IDL, lebDecode, type PipeArrayBuffer } from "@icp-sdk/core/candid";

// Retain one extra UTF-16 unit so the existing response code can distinguish a
// complete 40,000-unit body from a longer one and preserve its truncation flag.
const RETAIN_UNITS = 40_001;
// Three bytes per UTF-16 unit is the maximum; three extra bytes complete any
// code point crossing that byte boundary. Decode only this bounded prefix.
const PREFIX_BYTES = RETAIN_UNITS * 3 + 3;

/** Candid text on the wire, with bounded storage for MCP node bodies only. */
export function boundedNodeText(textType: IDL.TextClass): IDL.TextClass {
  const type = Object.create(textType) as IDL.TextClass;
  type.decodeValue = (pipe: PipeArrayBuffer, wireType: IDL.Type) => {
    textType.checkType(wireType);
    const length = Number(lebDecode(pipe));
    if (length > pipe.byteLength) throw new Error("unexpected end of buffer");
    const view = pipe.save();
    const bytes = view.subarray(0, length);
    pipe.restore(view.subarray(length));
    // Validate the complete signed field without allocating a discarded tail
    // string. nodejs_compat supplies the native UTF-8 validator in workerd.
    if (!isUtf8(bytes)) throw new TypeError("Invalid UTF-8 node content");
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const prefix = decoder.decode(bytes.subarray(0, PREFIX_BYTES), { stream: length > PREFIX_BYTES });
    let end = RETAIN_UNITS;
    if (prefix.charCodeAt(end - 1) >= 0xd800 && prefix.charCodeAt(end - 1) <= 0xdbff) end++;
    return prefix.slice(0, end);
  };
  return type;
}
