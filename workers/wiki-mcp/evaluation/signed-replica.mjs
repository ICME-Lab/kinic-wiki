// Local replica fixture: real BLS certificate chain and Ed25519 query signatures.
// Only the test network's root of trust differs; the Worker's SDK is unmodified.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { Cbor, reconstruct, requestIdOf, hashOfMap } = require('@icp-sdk/core/agent');
const { lebEncode } = require('@icp-sdk/core/candid');
const { Principal } = require('@icp-sdk/core/principal');
const { Ed25519KeyIdentity } = require('@icp-sdk/core/identity');
// Resolve the exact curve implementation pinned by the SDK, not another version.
const sdkRequire = createRequire(require.resolve('@icp-sdk/core/agent'));
const { bls12_381 } = sdkRequire('@noble/curves/bls12-381.js');
const bls = bls12_381.shortSignatures;
const bytes = value => typeof value === 'string' ? Buffer.from(value) : value;
const label = (name, child) => [2, bytes(name), child];
const leaf = value => [3, bytes(value)];
const fork = children => children.length === 1 ? children[0] : [1, children[0], fork(children.slice(1))];
const domain = value => Buffer.concat([Buffer.from([value.length]), Buffer.from(value)]);
const derPrefix = Buffer.from('308182301d060d2b0601040182dc7c0503010201060c2b0601040182dc7c05030201036100', 'hex');
const publicKey = secret => Buffer.concat([derPrefix, bls.getPublicKey(secret).toBytes()]);

export async function createSignedReplica(canisterText) {
  const rootSecret = bls.keygen().secretKey;
  const subnetSecret = bls.keygen().secretKey;
  const rootKey = publicKey(rootSecret);
  const subnetKey = publicKey(subnetSecret);
  const subnetId = Principal.selfAuthenticating(subnetKey).toUint8Array();
  const canister = Principal.fromText(canisterText).toUint8Array();
  const makeNodes = () => Array.from({ length: 13 }, () => Ed25519KeyIdentity.generate())
    .sort((a, b) => Buffer.compare(a.getPrincipal().toUint8Array(), b.getPrincipal().toUint8Array()));
  let nodes = makeNodes();
  async function certificate(tree, secret, delegation) {
    const message = Buffer.concat([domain('ic-state-root'), await reconstruct(tree)]);
    const signature = bls.sign(bls.hash(message), secret).toBytes();
    return Cbor.encode({ tree, signature, ...(delegation ? { delegation } : {}) });
  }
  let cachedCertificate, certificateTime = 0;
  return {
    rootKey,
    rotateNodeKeys() { nodes = makeNodes(); certificateTime = 0; },
    async readState(corrupt = false) {
      if (Date.now() - certificateTime > 5_000) {
        certificateTime = Date.now();
        const time = label('time', leaf(lebEncode(BigInt(certificateTime) * 1_000_000n)));
        const delegationTree = fork([
          label('subnet', label(subnetId, fork([
            label('canister_ranges', leaf(Cbor.encode([[canister, canister]]))),
            label('public_key', leaf(subnetKey))
          ]))), time
        ]);
        const delegation = { subnet_id: subnetId, certificate: await certificate(delegationTree, rootSecret) };
        const nodeTree = fork(nodes.map(node => label(node.getPrincipal().toUint8Array(),
          label('public_key', leaf(node.getPublicKey().toDer())))));
        cachedCertificate = await certificate(fork([
          label('subnet', label(subnetId, label('node', nodeTree))), time
        ]), subnetSecret, delegation);
      }
      let cert = cachedCertificate;
      if (corrupt) {
        const decoded = Cbor.decode(cert);
        decoded.signature[0] ^= 1;
        cert = Cbor.encode(decoded);
      }
      return Cbor.encode({ certificate: cert });
    },
    async query(content, arg, corrupt = false) {
      const timestamp = BigInt(Date.now()) * 1_000_000n;
      const reply = { arg };
      const hash = hashOfMap({ status: 'replied', reply, timestamp, request_id: requestIdOf(content) });
      const node = nodes[0];
      const signature = new Uint8Array(await node.sign(Buffer.concat([domain('ic-response'), hash])));
      if (corrupt) signature[0] ^= 1;
      return Cbor.encode({ status: 'replied', reply, signatures: [{
        timestamp, identity: node.getPrincipal().toUint8Array(), signature
      }] });
    }
  };
}
