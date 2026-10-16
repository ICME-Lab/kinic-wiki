/** Native Cordis integration: durable pre-step recall and observed session evidence. */
import { execFile } from 'node:child_process'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'kinic-learning'
export const inject = ['agents']

/** Validate deployment-specific CLI settings before registering listeners. */
function settings(config) {
  const result = {
    cliExecutable: config.cliExecutable ?? 'kinic-vfs-cli',
    cliArgs: config.cliArgs ?? [],
    recallConfig: config.recallConfig,
    timeoutMs: config.timeoutMs ?? 10000,
    maxOutputBytes: config.maxOutputBytes ?? 1024 * 1024,
    maxPendingRecords: config.maxPendingRecords ?? 128,
  }
  if (typeof result.cliExecutable !== 'string' || result.cliExecutable.length === 0
    || !Array.isArray(result.cliArgs) || result.cliArgs.some(arg => typeof arg !== 'string')
    || result.recallConfig !== undefined && typeof result.recallConfig !== 'string') {
    throw new TypeError('kinic-learning: CLI executable, argv, and recallConfig must be strings')
  }
  for (const key of ['timeoutMs', 'maxOutputBytes', 'maxPendingRecords']) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0) {
      throw new TypeError(`kinic-learning: ${key} must be a positive safe integer`)
    }
  }
  return result
}

/** Send one JSON request directly to the configured CLI; stdout is one JSON reply. */
function invoke(config, request, signal) {
  return new Promise((resolve, reject) => {
    const argv = [...config.cliArgs, 'agent', 'hook', '--engine', 'dsh', '--cwd', request.cwd]
    if (config.recallConfig !== undefined) argv.push('--recall-config', config.recallConfig)
    const child = execFile(config.cliExecutable, argv, {
      cwd: request.cwd,
      timeout: config.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: config.maxOutputBytes,
      encoding: 'utf8',
      signal,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) { reject(error); return }
      try {
        const reply = JSON.parse(stdout)
        if (reply === null || typeof reply !== 'object' || Array.isArray(reply)
          || reply.additionalContext !== undefined && typeof reply.additionalContext !== 'string'
          || reply.receipt_id !== undefined && typeof reply.receipt_id !== 'string') {
          throw new TypeError('kinic-learning: malformed CLI reply')
        }
        if (reply.error_code !== undefined || request.event !== 'recall' && reply.recorded !== true) {
          throw new TypeError('kinic-learning: CLI did not acknowledge the request')
        }
        resolve(reply)
      } catch (error) { reject(error) }
    })
    // execFile owns and reaps the process on timeout, abort, and maxBuffer failure.
    child.stdin.on('error', () => { /* execFile's callback reports early process termination. */ })
    child.stdin.end(JSON.stringify(request))
  })
}

/**
 * Install recall on each first accepted turn step, plus serial bounded evidence
 * recording. Recall failure preserves the downstream decision and emits a warning.
 * The emitted user message is committed by the normal agent-loop entry path.
 */
export function apply(ctx, config = {}) {
  const options = settings(config)
  const recalledTurns = new WeakMap()
  const sessionTurns = new WeakMap()
  const lifetime = new AbortController()
  let pending = Promise.resolve()
  let queued = 0
  let closing = false
  const warn = error => ctx.logger.warn(`kinic-learning: CLI request failed (${error.code ?? error.name ?? 'error'})`)
  const requestFor = (session, turn, event) => ({
    event, engine: 'dsh', session_id: String(session.id),
    run_id: `${String(session.id)}:${turn}`, turn_id: String(turn),
    cwd: session.header.cwd ?? process.cwd(),
  })

  ctx.effect(() => async () => {
    closing = true
    // Event listeners are removed by Cordis during this disposal. Finish the
    // bounded queue before cancelling any remaining pre-step subprocess.
    await pending
    lifetime.abort()
  })

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || closing || step !== 1
      || recalledTurns.get(agent.session) === turn) return decision
    const task = decision.messages
      .filter(message => message.source.kind === 'user')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
      .join('\n')
    if (task.trim().length === 0) return decision
    try {
      const reply = await invoke(options, { ...requestFor(agent.session, turn, 'recall'), task },
        AbortSignal.any([signal, lifetime.signal]))
      if (signal.aborted || closing) return decision
      recalledTurns.set(agent.session, turn)
      if (!reply.additionalContext) return decision
      return {
        ...decision,
        messages: [...decision.messages, createUserMessage({
          content: [{ type: 'text', text: reply.additionalContext }],
          source: {
            kind: name,
            form: 'recall',
            ...(reply.receipt_id === undefined ? {} : { receiptId: reply.receipt_id }),
          },
        })],
      }
    } catch (error) {
      warn(error)
      return decision
    }
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (closing) return
    const turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : sessionTurns.get(session) ?? 0
    if (event.type === 'turn/start') sessionTurns.set(session, turn)
    if (queued >= options.maxPendingRecords) {
      ctx.logger.warn('kinic-learning: evidence queue full; observed event was not recorded')
      return
    }
    // Snapshot before the detached request: later producer mutation must not
    // alter the fact the listener observed.
    let request
    try {
      request = JSON.parse(JSON.stringify({
        ...requestFor(session, turn, event.type === 'turn/end' ? 'Stop' : 'record'),
        ...(event.type === 'turn/end' ? { terminal: true } : {}),
        payload: { event },
      }))
    } catch (error) { warn(error); return }
    queued += 1
    pending = pending.then(() => invoke(options, request, lifetime.signal))
      .catch(warn)
      .finally(() => { queued -= 1 })
  })
}
