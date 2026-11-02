/** Gitea conversations for assessments and workers: `giteaThreadContext` by page, and the `gitea/` resources. */
import type { Trigger } from '../core/index.ts'
import { GiteaApi, type GiteaComment, type GiteaIssue } from './gitea-api.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

const PAGE = 20
/** A description or a comment as a model reads it; `bot` marks an account that is no person, whose words never authorize work. */
function message(record: GiteaIssue | GiteaComment, text: string): ContextMessage {
  const person = record.author.type === 'User' && record.author.id > 0 && !record.migrated
  return { id: record.url, from: record.author.login, at: record.createdAt, text, ...person ? {} : { bot: true }, url: record.url }
}
const description = (issue: GiteaIssue) => message(issue, `${issue.title}\n\n${issue.body}`)
/** Reads a conversation whole, as Gitea lists it, and gives it by page with the description first: its root and its parent. */
export const giteaThreadContext: ThreadContext<unknown> = {
  messageId: (trigger: Trigger) => trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    const api = GiteaApi.of(commands.deployment)
    const number = Number(trigger.meta.number)
    const messages = [description(await api.issue(number)), ...(await api.conversation(number)).map(comment => message(comment, comment.body))]
    const page = part === 'thread' ? Number(cursor ?? '1') : 1
    const read = messages.slice((page - 1) * PAGE, page * PAGE)
    const next = page * PAGE < messages.length ? String(page + 1) : undefined
    return { messages: read, next, body: { messages: read, next_resource: next ?? null } }
  },
}
/**
 * Reads `gitea/issues/<number>`, an Issue's or a pull request's description, `gitea/issues/<number>/comments/<page>`, its
 * conversation by page, or `gitea/pulls/<number>`, a pull request's state and branches.
 */
export async function readGitea(api: GiteaApi, resource: string): Promise<unknown> {
  const match = /^gitea\/(issues|pulls)\/([1-9]\d*)(?:\/comments\/([1-9]\d*))?$/.exec(resource)
  if (!match || (match[1] === 'pulls' && match[3])) throw new Error('Use gitea/issues/<number>, gitea/issues/<number>/comments/<page> or gitea/pulls/<number>')
  const number = Number(match[2])
  if (match[1] === 'pulls') {
    const pull = await api.pull(number)
    return { number, title: pull.title, state: pull.state, head: pull.head.ref, base: pull.base, author: pull.author, url: pull.url, body: pull.body }
  }
  if (!match[3]) {
    const issue = await api.issue(number)
    return { number, title: issue.title, state: issue.state, ...issue.isPr ? { pull_request: true } : {}, ...description(issue) }
  }
  const page = Number(match[3])
  const comments = await api.conversation(number)
  return { messages: comments.slice((page - 1) * PAGE, page * PAGE).map(comment => message(comment, comment.body)),
    ...page * PAGE < comments.length ? { next_resource: `gitea/issues/${number}/comments/${page + 1}` } : {} }
}
