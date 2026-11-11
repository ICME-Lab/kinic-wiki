/** Recovery proof key uses HKDF separate from wrapping/archive authentication. */
import { concat, utf8 } from "./index.ts";
export async function recoverySigningKey(secret:Uint8Array){
  if(secret.length!==32)throw Error("InvalidInput");
  const material=await crypto.subtle.importKey("raw",new Uint8Array(secret),"HKDF",false,["deriveBits"]);
  const seed=new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:new Uint8Array(32),info:utf8.encode("kinic-vault/recovery-proof/ed25519/v2")},material,256));
  // RFC8410 PKCS#8 wrapping for a raw Ed25519 seed, consumed by platform WebCrypto.
  const der=concat(new Uint8Array([0x30,0x2e,0x02,0x01,0,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]),seed);
  try{return await crypto.subtle.importKey("pkcs8",der,"Ed25519",true,["sign"]);}finally{seed.fill(0);der.fill(0);}
}
export async function recoveryVerifier(secret:Uint8Array){
  const key=await recoverySigningKey(secret),jwk=await crypto.subtle.exportKey("jwk",key);
  if(!jwk.x)throw Error("InvalidKey");
  return Uint8Array.from(atob(jwk.x.replaceAll("-","+").replaceAll("_","/")),x=>x.charCodeAt(0));
}
export async function signRecovery(secret:Uint8Array,challenge:Uint8Array){
  const key=await recoverySigningKey(secret);
  return new Uint8Array(await crypto.subtle.sign("Ed25519",key,concat(utf8.encode("kinic-vault/recovery-proof/v2\0"),challenge)));
}
