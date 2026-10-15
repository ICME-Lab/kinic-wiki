// Local SQLite Durable Object measurements; no production auth/state is accessed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(project + "package.json");
const { build } = require("esbuild");
const { Miniflare, convertV4MiniflareOptions } = createRequire(require.resolve("wrangler"))("miniflare");
const output = new URL("./.tmp/oauth-refresh/", import.meta.url);
await mkdir(output, { recursive: true });
const { outputFiles } = await build({
  stdin: { resolveDir: project, loader: "ts", contents: `
    import {McpAuthStateV5 as Base} from './src/auth/state.ts';
    import {sha256} from '@kinic/ii-server/crypto';
    import {II_SESSION_TTL_MS,MAX_REFRESH_ROTATIONS} from './src/auth/session-policy.ts';
    export class McpAuthStateV5 extends Base {
      async fetch(request) {
        const body=await request.json(), resource='https://fixture.invalid/mcp';
        if(body.action==='seed') {
          const now=Date.now(), verifier='v'.repeat(43), encrypted={version:1,algorithm:'AES-GCM',iv:'fixture',ciphertext:'fixture'};
          await this.createSession({sessionId:'fixture',clientId:'client',redirectUri:'https://chatgpt.com/callback',oauthState:'fixture',
            scope:'mcp:read',resource,codeChallenge:await sha256(verifier),connectStateHash:await sha256('state'),cookieHash:await sha256('cookie'),
            registrationPublicKey:'fixture',registrationKey:encrypted,sessionKey:encrypted,createdAt:now,sessionCapAt:now+II_SESSION_TTL_MS,connectExpiresAt:now+60000});
          await this.claimConnect('state','cookie',now);
          const completed=await this.completeConnect(now+II_SESSION_TTL_MS,'queries',now,'fixture');
          const issued=await this.exchangeCode({code:completed.code,clientId:'client',redirectUri:'https://chatgpt.com/callback',codeVerifier:verifier,issueRefreshToken:true,now});
          return Response.json({issued,limit:MAX_REFRESH_ROTATIONS});
        }
        if(body.action==='rotate') {
          let token=body.token,issued;
          for(let n=0;n<body.count;n++){
            issued=await this.rotateRefreshToken({refreshToken:token,clientId:'client',resource,now:Date.now()});
            if(!issued)throw new Error('Unexpected rotation failure');
            token=issued.refreshToken;
          }
          return Response.json(issued);
        }
        if(body.action==='stats') {
          const record=await this.ctx.storage.get('record');
          return Response.json({hashCount:record.spentRefreshTokenHashes.length,
            validHashes:record.spentRefreshTokenHashes.every(h=>/^[A-Za-z0-9_-]{43}$/.test(h)),
            recordBytes:new TextEncoder().encode(JSON.stringify(record)).byteLength});
        }
        if(body.action==='reject') {
          const issued=await this.rotateRefreshToken({refreshToken:body.token,clientId:'client',resource,now:Date.now()});
          const valid=await this.validateAccessToken(body.accessToken,resource,Date.now());
          return Response.json({rejected:issued===null,sessionRevoked:valid===null});
        }
        throw new Error('Unexpected local fixture action');
      }
    }
    export default {fetch(request,env){return env.MCP_AUTH_STATE.getByName(new URL(request.url).pathname).fetch(request);}};
  ` },
  bundle: true, platform: "browser", format: "esm", write: false,
  external: ["cloudflare:workers", "node:*"]
});
const mf = new Miniflare(convertV4MiniflareOptions({
  name: "oauth-refresh-benchmark", modules: true, script: outputFiles[0].text,
  compatibilityDate: "2026-05-12", compatibilityFlags: ["nodejs_compat"],
  durableObjects: { MCP_AUTH_STATE: { className: "McpAuthStateV5", useSQLite: true } }
}));
try {
  await mf.ready;
  const pid = execFileSync("pgrep", ["-P", String(process.pid), "-x", "workerd"], { encoding: "utf8" }).trim();
  assert.match(pid, /^\d+$/u);
  const cpu = () => process.platform === "darwin" ? Number(execFileSync("python3", ["-c",
    "import ctypes,struct,sys\nl=ctypes.CDLL('/usr/lib/libproc.dylib');s=ctypes.CDLL('/usr/lib/libSystem.B.dylib');b=ctypes.create_string_buffer(1024);assert l.proc_pid_rusage(int(sys.argv[1]),0,ctypes.byref(b))==0;t=(ctypes.c_uint32*2)();assert s.mach_timebase_info(ctypes.byref(t))==0;print(sum(struct.unpack_from('QQ',b.raw,16))*int(t[0])/int(t[1])/1e6)", pid], { encoding: "utf8" }).trim()) : null;
  const call = async (session, body) => {
    const response = await mf.dispatchFetch("https://fixture.invalid/" + session, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 200, "Local DO fixture failed");
    return response.json();
  };
  const seed = await call("history", { action: "seed" });
  let issued = seed.issued;
  assert.ok(issued.refreshToken);
  const batches = [];
  for (let n = 0; n < seed.limit; n += 64) {
    const startedCpu = cpu(), started = performance.now();
    issued = await call("history", { action: "rotate", token: issued.refreshToken, count: 64 });
    const elapsedWallMs = performance.now() - started;
    const elapsedCpu = cpu();
    batches.push({ rotations: 64, wallMsPerRotation: elapsedWallMs / 64,
      cpuMsPerRotation: elapsedCpu === null ? null : (elapsedCpu - startedCpu) / 64 });
    assert.equal(issued.sessionExpiresAt, seed.issued.sessionExpiresAt);
    assert.equal(issued.scope, "mcp:read");
  }
  const stored = await call("history", { action: "stats" });
  assert.equal(stored.hashCount, 4096);
  assert.equal(stored.validHashes, true);
  assert.ok(stored.recordBytes < 256 * 1024);
  // At a full history, check the oldest real token is still detected as replay.
  assert.deepEqual(await call("history", { action: "reject", token: seed.issued.refreshToken, accessToken: issued.accessToken }), { rejected: true, sessionRevoked: true });
  const report = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    node: process.version, bundleSha256: createHash("sha256").update(outputFiles[0].text).digest("hex"),
    measurement: "Local workerd process CPU and batched wall time, not Cloudflare billed CPU. Real SQLite DO rotation/storage; simulated II consent; excludes external II and DCR.",
    ...stored, rotations: seed.limit,
    firstBatch: batches[0], lastBatch: batches.at(-1),
    meanCpuMsPerRotation: batches[0].cpuMsPerRotation === null ? null : batches.reduce((sum, b) => sum + b.cpuMsPerRotation, 0) / batches.length,
    meanWallMsPerRotation: batches.reduce((sum, b) => sum + b.wallMsPerRotation, 0) / batches.length,
    replayRejected: true, batches
  };
  await writeFile(new URL("results.json", output), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ ...report, batches: undefined }));
} finally { await mf.dispose(); }
