import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Exact recalled text is carried by its durable user message. */
    'kinic-learning': { readonly kind: 'kinic-learning'; readonly form: 'recall'; readonly receiptId?: string }
  }
}
export const name: 'kinic-learning'
export const inject: string[]
export interface Config {
  /** CLI executable path; defaults to kinic-vfs-cli from PATH. */
  cliExecutable?: string
  /** Global CLI arguments, each as a separate argv element. */
  cliArgs?: string[]
  /** Project learning configuration path; omission lets the CLI discover .kinic-learning.json. */
  recallConfig?: string
  /** Per-CLI-call time limit; defaults to 10000 milliseconds. */
  timeoutMs?: number
  /** Limit for each output stream; defaults to 1048576 bytes. */
  maxOutputBytes?: number
  /** Maximum queued and running evidence records; defaults to 128. */
  maxPendingRecords?: number
}
/** Mount durable recall and evidence listeners in the supplied Cordis context. */
export function apply(ctx: Context, config?: Config): void
