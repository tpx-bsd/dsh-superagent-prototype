import { z } from 'zod'
import type { Ticket } from '../core/index.ts'
import type { SourceContext } from './host.ts'
import * as rules from './pull.ts'
import { githubPage, SOURCE, UserSchema } from './github-trigger.ts'

export { pullOf, ticketBranch } from './pull.ts'
const PullSchema = z.looseObject({
  title: z.string().optional(), state: z.string(), html_url: z.string(), user: UserSchema,
  body: z.string().nullish(), created_at: z.string().optional(),
  merged: z.boolean().optional(), merged_at: z.string().nullish(), closed_at: z.string().nullish(), auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
})
export type Pull = z.infer<typeof PullSchema> & { number: number }
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> =>
  ({ ...await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`), number })
const GITHUB: rules.PullThreads = { source: SOURCE, scope: '' }
function pullState(pr: Pull): rules.PullState {
  const endedAt = pr.merged_at ?? pr.closed_at
  return { number: pr.number, url: pr.html_url, author: pr.user.login, head: { ref: pr.head.ref, repository: pr.head.repo?.full_name ?? '' },
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open', ...endedAt ? { endedAt } : {}, autoMerge: pr.auto_merge != null }
}
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] => rules.pullsOf(ticket, GITHUB, open)
export const claimPull = (ctx: SourceContext, ticketId: string, pr: Pull): string | undefined => rules.claimPull(ctx, GITHUB, ticketId, pullState(pr))
export const observePull = async (ctx: SourceContext, pr: Pull): Promise<boolean> => rules.observePull(ctx, GITHUB, pullState(pr))
export const pullEndNotices = (ticket: Ticket, request: string, repository: string) =>
  rules.pullEndNotices(GITHUB, number => githubPage(repository, number, true), ticket, request)
