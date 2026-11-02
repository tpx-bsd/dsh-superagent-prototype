/** Host and context interfaces connecting Source plugins to the application; also imported by the web panel, so it must not import Node-only modules. */
import type { ChannelRef, ReceiveResult, OutboundMessage, Thread, ThreadFact, ThreadRef, Ticket, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Deployment, Machine, Probe, RepositoryAccess } from '../deployment.ts'
import type { SourceRegistry } from './registry.ts'
import type { SetupProblem } from '../setup.ts'
import type { Family, Key } from '../kv.ts'
import { fill } from '../infra/text.ts'

/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
export const HEALTH_TEXT = {
  setupPending: 'Waiting for the deployment check',
  sourceOff: 'Off',
  feishuCliUnset: 'The Source is on, and its bot lark-cli is not set',
  feishuBotMissing: 'Waiting for the Feishu bot',
  pollFailures: '{count} consecutive failed polls; last: {error}',
} as const
export type HealthCode = keyof typeof HEALTH_TEXT
export type Health = { state: 'starting' | 'ready' | 'paused' | 'error'; detail: string; at?: string; code?: HealthCode; values?: Record<string, string> }
export function health(state: Health['state'], code: HealthCode, values: Record<string, string> = {}): Health {
  return { state, detail: fill(HEALTH_TEXT[code], values), code, ...Object.keys(values).length ? { values } : {} }
}
export interface SourceHost {
  readonly sources: SourceRegistry
  /** Returns the context for one Source kind; its `report` writes only the health entries declared by the kind. */
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}
/** Display label, URL, and facts (`null` removes a fact) that a Source publishes on a Thread. */
export interface ThreadDescription { label?: string; url?: string; facts?: Record<string, ThreadFact | null> }
/** Application capabilities exposed to a Source kind for reading state, ingesting triggers, managing threads/tickets, and reporting health. */
export interface SourceContext {
  readonly deployment: Deployment
  readonly commands: Commands
  readonly ready: Promise<void>
  /** True once setup resolved the repository and accounts; Sources poll only then. */
  configured(): boolean
  /** Setup problem keeping this Source's account from running; only the Feishu bot check reports one. */
  readonly problem?: SetupProblem | undefined
  /** Returns a Source's configuration while enabled, or undefined while disabled or uninstalled. */
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  /** Ingests a trigger into the Engine and schedules the next evaluation pass; callers should await completion before advancing read cursors. */
  receive(trigger: Trigger): ReceiveResult | Promise<ReceiveResult>
  atomic<T>(work: () => T): T
  /** Source-scoped KV records (such as read cursors); setting `undefined` removes an entry. */
  state: { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V | undefined): void; keys<V>(family: Family<V, never>): Key<V>[] }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: ThreadDescription): void
    /** Sets or removes (`undefined`) keys in a Thread's `meta` after rereading it; a missing Thread is left alone. */
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    /** Open tickets, newest first. */
    open(): Ticket[]
    /** Binds an open ticket to follow a Source Thread (`own` when opened by the ticket) so the Thread's close, not a ready report, ends the ticket. */
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    /** Reports that a followed Thread closed at `at`; each open ticket following it ends once no `own` Thread remains open and no resumed work is still running. */
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; /** The newest Trigger on a Thread. */ latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  /** Reports the state of one of this kind's declared health entries; throws for undeclared entry names. */
  report(entry: string, health: Health): void
}
export const sourceContext = (host: SourceHost, kind: { kind: string; health: readonly string[] }): SourceContext => host.context(kind)
/** The repository host the deployment binds. */
export interface RepositoryHost {
  /** The Source it binds, as `SourceHost.context` takes it; `kind` also names its settings block, its `SETUP_FIELDS` and its built-in skill. */
  readonly source: { readonly kind: string; readonly health: readonly string[] }
  /**
   * Checks the account CLI and its push access to the configured repository, and returns the canonical repository with the account
   * and its git access.
   * @throws SetupError placed at the Source's kind
   */
  resolve(machine: Pick<Machine, 'stateDir'>, config: unknown, probe: Probe, path?: string): Promise<RepositoryAccess>
  /** A non-hidden file, or a directory's listing, on the default branch of the configured repository. */
  readPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string>
  /**
   * Reads a pull request a worker reported. The claim it returns is synchronous so the caller runs it inside its `atomic`; the claim
   * binds the pull request to the Ticket and answers nothing, or answers why it does not belong to the Ticket.
   */
  pullClaim(ctx: SourceContext, ticketId: string, number: number, signal?: AbortSignal): Promise<() => string | undefined>
  /** The chat notices of a Ticket that ended with its pull request merged or closed. */
  pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[]
}
