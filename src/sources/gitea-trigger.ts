import { key, threadKey, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'
import { repositoryKey, type GiteaComment, type GiteaConnection, type GiteaIssue, type GiteaUser } from './gitea-api.ts'
import type { PullThreads } from './pull.ts'

export const SOURCE = 'gitea'
type Repository = Pick<GiteaConnection, 'server' | 'repository'>
/** The Threads of one repository's Issues and pull requests, `gitea:<repository key>:<number>`, so another server or repository never shares them. */
export const giteaThreads = ({ server, repository }: Repository): PullThreads => ({ source: SOURCE, scope: `${repositoryKey(server, repository)}:` })
export const giteaThread = (repository: Repository, number: number) => ({ source: SOURCE, id: `${giteaThreads(repository).scope}${number}` })
/**
 * Who wrote a record: the agent itself, a person, or automation. Only a positive-id User whose record was not migrated from another
 * service, and whom the Policy does not list among the bots, is a person; a Bot, a missing or unknown type, and the server's
 * placeholder users are automation, which never gains a person's authority.
 */
export type Author = { kind: 'self' | 'person' | 'automation'; login: string }
export function authorOf(user: GiteaUser, migrated: boolean, agent: string, bots: readonly string[]): Author {
  if (sameName(user.login, agent)) return { kind: 'self', login: user.login }
  const person = user.type === 'User' && user.id > 0 && !migrated && !bots.some(bot => sameName(bot, user.login))
  return { kind: person ? 'person' : 'automation', login: user.login }
}
/** True when `text` mentions `login`, whose characters Gitea allows to include dots, dashes and underscores. */
export const mentions = (text: string, login: string): boolean =>
  new RegExp(`(?:^|[^\\w@.-])@${escapeRegExp(login)}(?![\\w-]|\\.\\w)`, 'i').test(text)
/** The reply address of a conversation: its server and repository, which a reply must still be configured for, and its number. */
export const giteaChannel = (repository: Repository, number: number, url?: string): ChannelRef =>
  ({ source: SOURCE, thread: threadKey(giteaThread(repository, number)),
    address: { server: repository.server, repository: repository.repository, number: String(number), ...url ? { url } : {} } })
function trigger(repository: Repository, number: number, isPr: boolean, author: Author, agent: string, record: { id: string; at: string; text: string; addressed: string; url: string },
  meta: Record<string, unknown>): Trigger {
  return { id: record.id, source: SOURCE, threads: [giteaThread(repository, number)], actor: { source: SOURCE, id: author.login },
    human: author.kind === 'person', ...mentions(record.addressed, agent) ? { addressed: 'mention' as const } : {}, at: record.at, text: record.text,
    channel: giteaChannel(repository, number), url: record.url,
    meta: { server: repository.server, repository: repository.repository, number, isPr, ...meta } }
}
/** The Trigger of an Issue's or a pull request's title and description; an edit of the description makes none, as on GitHub. */
export const issueTrigger = (repository: Repository, issue: GiteaIssue, author: Author, agent: string): Trigger =>
  trigger(repository, issue.number, issue.isPr, author, agent, { id: key('gitea-issue', repository.server, repository.repository.toLowerCase(), String(issue.number)),
    at: issue.createdAt, text: `${issue.title}\n\n${issue.body}`, addressed: issue.body, url: issue.url }, { kind: issue.isPr ? 'pull' : 'issue' })
/** The Trigger of a comment; an edit makes a new one, which carries the edited text. */
export const commentTrigger = (repository: Repository, comment: GiteaComment, author: Author, agent: string): Trigger =>
  trigger(repository, comment.number, comment.isPr, author, agent, {
    id: key('gitea-comment', repository.server, repository.repository.toLowerCase(), String(comment.id), comment.updatedAt),
    at: comment.updatedAt, text: comment.body, addressed: comment.body, url: comment.url }, { kind: 'comment', commentId: comment.id })
