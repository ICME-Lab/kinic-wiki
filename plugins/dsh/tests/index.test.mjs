import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Agents, { agentEvents } from '@deepseek-ai/dsh-agent'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as plugin from '../index.js'

async function fixture(t, body = '', overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'kinic-dsh-plugin-'))
  const script = join(dir, 'cli.mjs')
  const log = join(dir, 'calls.jsonl')
  await writeFile(script, `import {readFileSync,appendFileSync} from 'node:fs';
const r=JSON.parse(readFileSync(0,'utf8'));appendFileSync(process.argv[2],JSON.stringify({request:r,argv:process.argv.slice(3)})+'\\n');
${body || "console.log(JSON.stringify(r.event==='recall'?{additionalContext:'Conditional lesson',receipt_id:'receipt-1'}:{recorded:true}))"}`)
  const ctx = new Context()
  await ctx.plugin(Agents)
  t.after(async () => { await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const fiber = await ctx.plugin(plugin, { cliExecutable: process.execPath, cliArgs: [script, log], recallConfig: join(dir,'recall.json'), timeoutMs: 500, maxOutputBytes: 10000, maxPendingRecords: 16, ...overrides })
  const session = Session.create(SessionId('session-1'), [], {version: SESSION_FORMAT_VERSION, isSeeded: false, id: SessionId('session-1'), cwd:dir, createdAt: Date.now()})
  const agent = { id: session.id, session, options: {}, ctx: new Context() }
  const messages = [createUserMessage({ content: [{type:'text',text:'Fix the task'}],source:{kind:'user'} })]
  const preStep = (step = 1, fallback) => agentEvents(ctx, agent).waterfall('agent/pre-step', { messages, turn: 1, step, signal: new AbortController().signal }, fallback || (() => Promise.resolve({kind:'enter',messages})))
  const calls = async () => (await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  return { dir, ctx, fiber, session, agent, messages, preStep, calls }
}

test('accepted first step adds a sourced durable message and binds recall to turn', async t => {
  const f = await fixture(t)
  const decision = await f.preStep()
  assert.equal(decision.kind,'enter')
  assert.equal(decision.messages.length,2)
  const context = decision.messages[1]
  assert.equal(context.content[0].text,'Conditional lesson')
  assert.equal(context.source.kind,'kinic-learning')
  assert.equal(context.source.receiptId,'receipt-1')
  f.session.append('turn/start',{turn:1})
  for(const message of decision.messages) f.session.append('user/message',message,{surfaceOp:'append'})
  assert.equal(f.session.deriveMessages()[1].content[0].text,'Conditional lesson')
  const [{request,argv}] = await f.calls()
  assert.equal(request.event,'recall');assert.equal(request.engine,'dsh');assert.equal(request.task,'Fix the task')
  assert.equal(request.run_id,'session-1:1')
  assert.deepEqual(argv.slice(0,4),['agent','hook','--engine','dsh'])
  assert.ok(argv.includes('--recall-config'))
  assert.equal((await f.preStep(2)).messages.length,1)
  assert.equal((await f.calls()).length,1)
})

test('downstream reject never invokes recall and unknown outcomes remain evidence', async t => {
  const f = await fixture(t)
  assert.equal((await f.preStep(1,()=>Promise.resolve({kind:'reject',reason:'blocked'}))).kind,'reject')
  f.ctx.emit('session/event',f.session,{type:'turn/start',seq:1,data:{turn:3}})
  f.ctx.emit('session/event',f.session,{type:'turn/end',seq:2,data:{turn:3,reason:{kind:'max-tokens'}}})
  await f.fiber.dispose()
  const calls = await f.calls()
  assert.equal(calls.length,2)
  assert.equal(calls[0].request.event,'record')
  assert.equal(calls[1].request.event,'Stop')
  assert.equal(calls[1].request.terminal,true)
  assert.equal(calls[1].request.turn_id,'3')
  assert.equal(calls[1].request.run_id,'session-1:3')
  assert.equal(calls[1].request.payload.event.data.reason.kind,'max-tokens')
  assert.equal(calls[1].request.payload.claimed_success,undefined)
})

test('CLI failures do not insert invented recall context or block subsequent listeners', async t => {
  const f = await fixture(t,"process.exitCode=1;console.error('offline')")
  const decision = await f.preStep()
  assert.equal(decision.messages.length,1)
  assert.equal(decision.messages[0].content[0].text,'Fix the task')
})


test('timeout forcibly ends a CLI that ignores graceful termination', async t => {
  const f = await fixture(t, "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(),1500)", {timeoutMs:100})
  const start = Date.now()
  const decision = await f.preStep()
  assert.equal(decision.messages.length,1)
  assert.ok(Date.now()-start < 1000,'CLI timeout did not bound execution')
})

test('shared project configuration omits legacy recall file and selects session cwd before routing', async t => {
  const f = await fixture(t, '', { recallConfig: undefined })
  await f.preStep()
  const [{ request, argv }] = await f.calls()
  assert.ok(!argv.includes('--recall-config'))
  assert.equal(argv[argv.indexOf('--cwd') + 1], request.cwd)
  assert.equal(request.cwd, f.dir)
})

test('structured hook failure does not mark recall delivered or suppress retry', async t => {
  const f = await fixture(t, "console.log(JSON.stringify({error_code:'hook_failed',recorded:false}))")
  assert.equal((await f.preStep()).messages.length, 1)
  assert.equal((await f.preStep()).messages.length, 1)
  assert.equal((await f.calls()).length, 2)
})

test('record failure or missing acknowledgment produces a sanitized warning', async t => {
  for (const reply of [{}, {error_code:'PRIVATE_FAILURE_DETAIL',recorded:false}]) {
    const f = await fixture(t, `console.log(JSON.stringify(${JSON.stringify(reply)}))`)
    const logs = []
    f.ctx.logger.exporter({ levels: { default: 3 }, export: message => logs.push(message) })
    f.ctx.emit('session/event',f.session,{type:'turn/end',seq:1,data:{turn:1,reason:{kind:'completed'}}})
    await f.fiber.dispose()
    const messages = JSON.stringify(logs)
    assert.ok(messages.includes('CLI request failed'), messages)
    assert.ok(!messages.includes('PRIVATE_FAILURE_DETAIL'))
  }
})

test('serial CLI observations reach Stop before any subsequent turn and no plugin drain runs', async t => {
  const f = await fixture(t)
  f.ctx.emit('session/event',f.session,{type:'turn/start',seq:1,data:{turn:2}})
  f.ctx.emit('session/event',f.session,{type:'tool/result',seq:2,data:{id:'tool-1',result:{exit_code:1}}})
  f.ctx.emit('session/event',f.session,{type:'turn/end',seq:3,data:{turn:2,reason:{kind:'completed'}}})
  f.ctx.emit('session/event',f.session,{type:'turn/start',seq:4,data:{turn:3}})
  await f.fiber.dispose()
  const calls = await f.calls()
  assert.deepEqual(calls.map(c=>c.request.payload.event.seq),[1,2,3,4])
  assert.deepEqual(calls.map(c=>c.request.run_id),['session-1:2','session-1:2','session-1:2','session-1:3'])
  assert.deepEqual(calls.map(c=>c.request.event),['record','record','Stop','record'])
  assert.equal(calls[2].request.terminal,true)
  assert.equal(calls[2].request.payload.claimed_success,undefined)
  assert.ok(calls.every(c=>c.argv.slice(0,2).join(' ')==='agent hook'))
})
