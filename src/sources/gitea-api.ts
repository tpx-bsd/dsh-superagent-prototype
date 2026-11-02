/**
 * The Gitea API of the configured repository, read and written as the agent account. The only place that sends Gitea requests,
 * reads the token file, parses Gitea's records into the types below and pages Gitea's lists.
 */
import { z } from 'zod'
import { key } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { CliError, type Tally } from '../infra/commands.ts'
import { readToken } from './gitea-token.ts'
import type { PullState } from './pull.ts'

/** The repository a deployment works on: the server's base URL as `giteaServer` returns it, `owner/name` and the token file. */
export interface GiteaConnection { server: string; repository: string; tokenFile: string }
/** How Gitea says who wrote something; any other or missing type is `unknown`. */
export interface GiteaUser { id: number; login: string; type: 'User' | 'Bot' | 'Organization' | 'unknown' }
/** An Issue or pull request description; `migrated` marks content imported from another service under a placeholder author. */
export interface GiteaIssue {
  number: number; isPr: boolean; title: string; body: string; author: GiteaUser; migrated: boolean
  createdAt: string; updatedAt: string; url: string; locked: boolean
}
/** A comment of an Issue's or a pull request's conversation. */
export interface GiteaComment {
  id: number; number: number; isPr: boolean; body: string; author: GiteaUser; migrated: boolean; createdAt: string; updatedAt: string; url: string
}
export interface GiteaPull extends PullState { title: string; body: string; base: string; headSha: string }
/** A time window of a repository list, `since` included and `before` excluded, as Gitea's `since` and `before` filters read it. */
export type Window = { since: string; before: string }

/**
 * A Gitea request that failed: `code` is its HTTP status, or undefined when no answer arrived (`network`) or the answer could not
 * be read (`malformed`). The message names the operation and the status, never a header, an answer's body or the token.
 */
export class GiteaError extends CliError {
  constructor(readonly operation: string, readonly failure: 'status' | 'network' | 'malformed', code?: number, detail = '') {
    super(`Gitea ${operation}: ${failure === 'status' ? `HTTP ${code}` : failure === 'network' ? `no answer${detail ? ` (${detail})` : ''}` : 'unreadable answer'}`, code)
  }
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])
/**
 * The base URL of a Gitea server, without a trailing slash, as the server URL setting names it; a server under a path keeps it.
 * @throws Error saying why the URL is refused: not HTTPS outside loopback, with credentials, a query or a fragment.
 */
export function giteaServer(text: string): string {
  let url: URL
  try { url = new URL(text) } catch { throw new Error('it is not a URL') }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new Error('it must use https, except on this machine')
  if (url.username || url.password) throw new Error('it must not hold credentials; the token belongs in the token file')
  if (url.search || url.hash) throw new Error('it must not have a query or a fragment')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}
/** A short id of one repository on one server, which the Threads and read positions of that repository carry. */
export const repositoryKey = (server: string, repository: string): string => key('gitea', server.toLowerCase(), repository.toLowerCase()).slice(0, 12)

const Time = z.string().transform((text, ctx) => {
  const at = Date.parse(text)
  if (Number.isNaN(at)) { ctx.addIssue({ code: 'custom', message: 'not a time' }); return z.NEVER }
  return new Date(at).toISOString()
})
const UserSchema = z.looseObject({ id: z.number().int(), login: z.string().min(1), type: z.string().optional() })
  .transform((user): GiteaUser => ({ id: user.id, login: user.login,
    type: user.type === 'User' || user.type === 'Bot' || user.type === 'Organization' ? user.type : 'unknown' }))
const Migrated = { original_author: z.string().nullish() }
const IssueSchema = z.looseObject({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullish(), user: UserSchema, ...Migrated,
  created_at: Time, updated_at: Time, html_url: z.string(), is_locked: z.boolean().optional(), pull_request: z.unknown().optional(),
}).transform((issue): GiteaIssue => ({ number: issue.number, isPr: issue.pull_request != null, title: issue.title, body: issue.body ?? '',
  author: issue.user, migrated: !!issue.original_author, createdAt: issue.created_at, updatedAt: issue.updated_at, url: issue.html_url,
  locked: issue.is_locked ?? false }))
const CommentSchema = z.looseObject({
  id: z.number().int().positive(), body: z.string().nullish(), user: UserSchema, ...Migrated, created_at: Time, updated_at: Time,
  html_url: z.string(), issue_url: z.string().nullish(), pull_request_url: z.string().nullish(),
}).transform((comment, ctx): GiteaComment => {
  const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec(comment.pull_request_url || comment.issue_url || '')?.[1])
  if (!number) ctx.addIssue({ code: 'custom', message: 'names no Issue or pull request' })
  return { id: comment.id, number, isPr: !!comment.pull_request_url, body: comment.body ?? '', author: comment.user,
    migrated: !!comment.original_author, createdAt: comment.created_at, updatedAt: comment.updated_at, url: comment.html_url }
})
const Branch = z.looseObject({ ref: z.string(), sha: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() })
const PullSchema = z.looseObject({
  number: z.number().int().positive(), title: z.string(), body: z.string().nullish(), html_url: z.string(), user: UserSchema,
  state: z.enum(['open', 'closed']), merged: z.boolean(), merged_at: Time.nullish(), closed_at: Time.nullish(), head: Branch, base: Branch,
}).transform((pull): GiteaPull => {
  const endedAt = pull.merged_at ?? pull.closed_at
  return { number: pull.number, url: pull.html_url, author: pull.user.login, head: { ref: pull.head.ref, repository: pull.head.repo?.full_name ?? '' },
    state: pull.merged ? 'merged' : pull.state, ...endedAt ? { endedAt } : {}, title: pull.title, body: pull.body ?? '', base: pull.base.ref,
    headSha: pull.head.sha }
})
const RepositorySchema = z.looseObject({ full_name: z.string(), default_branch: z.string(), permissions: z.looseObject({ push: z.boolean() }).nullish() })
const MeSchema = z.looseObject({ email: z.string().nullish() }).and(UserSchema)

/** Pages Gitea asks no client to read past; a list that long, or a server that pages endlessly, fails as malformed. */
const MAX_PAGES = 200
const PAGE = 50
/**
 * The configured repository on Gitea as the agent account. Each request reads the token file anew and sends it only as the
 * `Authorization` header; a redirect is refused, so the token never follows one to another address.
 */
export class GiteaApi {
  private constructor(private readonly connection: GiteaConnection, private readonly signal?: AbortSignal) {}
  static connect(connection: GiteaConnection, signal?: AbortSignal): GiteaApi { return new GiteaApi(connection, signal) }
  /** @throws Error for a deployment whose account has no Gitea token. */
  static of(deployment: Pick<Deployment, 'account' | 'repository'>, signal?: AbortSignal): GiteaApi {
    const { account, repository } = deployment
    if (!('tokenFile' in account)) throw new Error('This installation\'s repository is not on Gitea')
    return new GiteaApi({ server: account.server, repository, tokenFile: account.tokenFile }, signal)
  }
  /** The server's version, and its clock's time from the answer's `Date`, which bounds a poll's window. */
  async version(): Promise<{ version: string; at: string }> {
    const { body, headers } = await this.request('version', '/version')
    const at = Date.parse(headers.get('date') ?? '')
    if (Number.isNaN(at)) throw new GiteaError('version', 'malformed')
    return { version: this.parse('version', z.looseObject({ version: z.string().min(1) }), body).version, at: new Date(at).toISOString() }
  }
  async me(): Promise<GiteaUser & { email: string }> {
    const user = this.parse('user', MeSchema, (await this.request('user', '/user')).body)
    return { id: user.id, login: user.login, type: user.type, email: user.email ?? '' }
  }
  async repository(): Promise<{ fullName: string; defaultBranch: string; push: boolean }> {
    const repository = this.parse('repository', RepositorySchema, (await this.request('repository', this.path(''))).body)
    return { fullName: repository.full_name, defaultBranch: repository.default_branch, push: repository.permissions?.push ?? false }
  }
  /** The Issues and pull requests updated within `window`, whatever their state. */
  issues(window: Window, tally?: Tally): Promise<GiteaIssue[]> {
    return this.list('issues', this.path('/issues', { state: 'all', ...window }), IssueSchema, issue => issue.number, tally)
  }
  /** The repository's conversation comments updated within `window`. */
  comments(window: Window, tally?: Tally): Promise<GiteaComment[]> {
    return this.list('comments', this.path('/issues/comments', window), CommentSchema, comment => comment.id, tally)
  }
  async issue(number: number): Promise<GiteaIssue> {
    return this.parse('issue', IssueSchema, (await this.request('issue', this.path(`/issues/${number}`))).body)
  }
  /** Every comment of one conversation. */
  conversation(number: number, tally?: Tally): Promise<GiteaComment[]> {
    return this.list('conversation', this.path(`/issues/${number}/comments`), CommentSchema, comment => comment.id, tally)
  }
  async pull(number: number): Promise<GiteaPull> {
    return this.parse('pull request', PullSchema, (await this.request('pull request', this.path(`/pulls/${number}`))).body)
  }
  /** The pull requests `poster` opened against `base`, in every state. */
  pulls(poster: string, base: string): Promise<GiteaPull[]> {
    return this.list('pull requests', this.path('/pulls', { state: 'all', poster, base_branch: base }), PullSchema, pull => pull.number)
  }
  async createPull(draft: { head: string; base: string; title: string; body: string }): Promise<GiteaPull> {
    const { body } = await this.request('pull request creation', this.path('/pulls'), { method: 'POST', body: draft })
    return this.parse('pull request creation', PullSchema, body)
  }
  async comment(number: number, text: string): Promise<void> {
    await this.request('comment', this.path(`/issues/${number}/comments`), { method: 'POST', body: { body: text } })
  }
  /** A file of the default branch, as text. */
  async file(path: string): Promise<string> {
    return (await this.request('file', this.path(`/raw/${path.split('/').map(encodeURIComponent).join('/')}`), { raw: true })).body as string
  }
  /** The names in a directory of the default branch. */
  async directory(path: string): Promise<string[]> {
    const { body } = await this.request('directory', this.path(`/contents/${path.split('/').map(encodeURIComponent).join('/')}`))
    const entries = this.parse('directory', z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]), body)
    if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`)
    return entries.map(entry => entry.name)
  }
  private path(path: string, query: Record<string, string> = {}): string {
    const search = new URLSearchParams(query).toString()
    return `/repos/${this.connection.repository}${path}${search ? `?${search}` : ''}`
  }
  private parse<T>(operation: string, schema: z.ZodType<T, unknown>, body: unknown): T {
    const parsed = schema.safeParse(body)
    if (!parsed.success) throw new GiteaError(operation, 'malformed')
    return parsed.data
  }
  /**
   * Reads every page of a list. Gitea caps a page below the limit asked for and some lists ignore paging, so a list ends with
   * `X-Total-Count` items, an empty page, or a page that holds nothing new; a short page alone does not end it.
   */
  private async list<T>(operation: string, path: string, item: z.ZodType<T, unknown>, id: (item: T) => number, tally?: Tally): Promise<T[]> {
    const items = new Map<number, T>()
    let received = 0
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { body, headers } = await this.request(operation, `${path}${path.includes('?') ? '&' : '?'}page=${page}&limit=${PAGE}`)
      const listed = this.parse(operation, z.array(z.unknown()), body)
      const before = items.size
      let skipped = 0
      for (const value of listed) {
        const parsed = item.safeParse(value)
        if (parsed.success) items.set(id(parsed.data), parsed.data); else skipped++
      }
      if (!listed.length || (items.size === before && !skipped)) return [...items.values()]
      received += items.size - before + skipped
      if (tally) tally.skipped += skipped
      const total = Number(headers.get('x-total-count') ?? NaN)
      if (Number.isFinite(total) && received >= total) return [...items.values()]
    }
    throw new GiteaError(operation, 'malformed')
  }
  private async request(operation: string, path: string, options: { method?: 'POST'; body?: unknown; raw?: true } = {}): Promise<{ body: unknown; headers: Headers }> {
    const token = readToken(this.connection.tokenFile)
    let response: Response
    try {
      response = await fetch(`${this.connection.server}/api/v1${path}`, { method: options.method ?? 'GET', redirect: 'manual',
        signal: AbortSignal.any([...this.signal ? [this.signal] : [], AbortSignal.timeout(60_000)]),
        headers: { Authorization: `token ${token}`, Accept: 'application/json', ...options.body ? { 'Content-Type': 'application/json' } : {} },
        ...options.body ? { body: JSON.stringify(options.body) } : {} })
    } catch (error) {
      if (this.signal?.aborted) throw error
      const cause = error instanceof Error && error.cause instanceof Error ? (error.cause as NodeJS.ErrnoException).code ?? error.cause.message : ''
      throw new GiteaError(operation, 'network', undefined, error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : cause)
    }
    if (!response.ok) { await response.body?.cancel(); throw new GiteaError(operation, 'status', response.status) }
    const text = await response.text()
    if (options.raw) return { body: text, headers: response.headers }
    try { return { body: text ? JSON.parse(text) : null, headers: response.headers } } catch { throw new GiteaError(operation, 'malformed') }
  }
}
