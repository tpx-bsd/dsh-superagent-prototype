/** The pull request rules every repository host shares: which pull requests a Ticket follows, their closes, and the end notices. */
import { key, liveTicket, threadKey, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'

/** A pull request as the rules read it on any host. */
export interface PullState {
  number: number
  url: string
  author: string
  head: { ref: string; repository: string }
  state: 'open' | 'closed' | 'merged'
  /** When it closed or merged. */
  endedAt?: string
  autoMerge?: boolean
}
/** Where a host keeps its pull requests among Threads: `<source>:<scope><number>`. */
export interface PullThreads { readonly source: string; readonly scope: string }

const threadOf = (threads: PullThreads, number: number) => ({ source: threads.source, id: `${threads.scope}${number}` })
function numberOf(threads: PullThreads, thread: string): number | undefined {
  const prefix = `${threads.source}:${threads.scope}`
  const number = thread.startsWith(prefix) ? Number(thread.slice(prefix.length)) : NaN
  return Number.isInteger(number) && number > 0 ? number : undefined
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, threads: PullThreads, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => numberOf(threads, item.thread) ?? [])
/** The pull request a Ticket follows on whichever host bound it: the latest open one, else the latest one. */
export function pullOf(ticket: Pick<Ticket, 'follows'>): number | undefined {
  const number = (follow: Follow | undefined) => follow && Number(follow.thread.slice(follow.thread.lastIndexOf(':') + 1))
  const follows = ticket.follows ?? []
  return number(follows.filter(item => !item.closed).at(-1)) ?? number(follows.at(-1))
}
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (pr: PullState, deployment: Pick<Deployment, 'account' | 'repository'>): boolean =>
  sameName(pr.author, deployment.account.login) && sameName(pr.head.repository, deployment.repository)
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name
const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, threads: PullThreads, ticketId: string, pr: PullState): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its PR was closed'
  const thread = threadOf(threads, pr.number)
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = !!source && source.meta.isPr === true && threadKey(source.threads[0]!) === threadKey(thread)
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref)
  if (!started && !opened) {
    const { login } = ctx.deployment.account
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, threads, true).includes(pr.number))
  if (owner && owner.id !== ticketId) return 'PR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === threadKey(thread))
  if (pr.state === 'open' && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, threads, ticketId, pr, opened)
  return undefined
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export function observePull(ctx: SourceContext, threads: PullThreads, pr: PullState): boolean {
  const ended = pr.state !== 'open'
  const thread = threadKey(threadOf(threads, pr.number))
  if (ended) closePull(ctx, threads, pr)
  else {
    const candidates = agentPull(pr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === thread && item.closed)
    if (ticket && (reopened || pullsOf(ticket, threads, true).every(number => number === pr.number))) claimPull(ctx, threads, ticket.id, pr)
  }
  ctx.threads.describe(thread, { facts: { autoMerge: !ended && pr.autoMerge ? AUTO_MERGE_ON : null } })
  return ended
}
function bind(ctx: SourceContext, threads: PullThreads, ticketId: string, pr: PullState, own: boolean): void {
  const thread = threadOf(threads, pr.number)
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, thread, own)
    ctx.threads.patch(threadKey(thread), { number: pr.number, isPr: true, url: pr.url, prAuthor: pr.author })
  })
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, threads: PullThreads, pr: PullState): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, threads, true).includes(pr.number))) return
  ctx.tickets.threadClosed(threadOf(threads, pr.number), pr.state === 'merged' ? 'merged' : 'closed', pr.endedAt ?? new Date().toISOString())
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English. The host's own conversations already show the outcome, so they are skipped.
 */
export function pullEndNotices(threads: PullThreads, page: (number: number) => string, ticket: Ticket, request: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && numberOf(threads, item.thread) !== undefined)
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = numberOf(threads, follow.thread)!
  const url = page(number)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[PR #${number}](${url}) 已合并。` : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[PR #${number}](${url}) has merged.` : `[PR #${number}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== threads.source).map(channel => ({
    id: key('pr-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
