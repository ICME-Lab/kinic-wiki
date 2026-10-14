import { isUtf8 } from "node:buffer";
import { IDL, lebDecode, type PipeArrayBuffer } from "@icp-sdk/core/candid";

// Retain one extra UTF-16 unit so the existing response code can distinguish a
// complete 40,000-unit body from a longer one and preserve its truncation flag.
const RETAIN_UNITS = 40_001;
// Three bytes per UTF-16 unit is the maximum; three extra bytes complete any
// code point crossing that byte boundary. Decode only this bounded prefix.
const PREFIX_BYTES = RETAIN_UNITS * 3 + 3;

export type BoundedNodeContent = { text: string; originalLength: number };

// Input has already passed isUtf8. Count Unicode scalars directly from their
// leading bytes; supplementary scalars occupy two UTF-16 units. No tail string
// or byte copy is needed, even when nearly the whole body is omitted.
function utf16Length(bytes: Uint8Array): number {
  let units = 0;
  for (let i = 0; i < bytes.length;) {
    const byte = bytes[i];
    units += byte >= 0xf0 ? 2 : 1;
    i += byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
  }
  return units;
}

/** Candid text on the wire, with bounded storage for MCP node bodies only. */
export function boundedNodeText(textType: IDL.TextClass): IDL.Type<BoundedNodeContent> {
  const type = Object.create(textType) as IDL.Type<BoundedNodeContent>;
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
    return { text: prefix.slice(0, end), originalLength: length <= PREFIX_BYTES ? prefix.length : utf16Length(bytes) };
  };
  return type;
}
