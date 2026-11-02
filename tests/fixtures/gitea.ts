/**
 * A stand-in Gitea server for one repository, `acme/widgets`, answering the API calls dsh-superagent makes as Gitea 28.3 does:
 * times with an offset, `since` and `before` on the update time, pages capped at two records whatever the limit, per-conversation
 * comments that ignore paging, and HTTP 409 for a second open pull request of one branch. `fail` breaks the next matching request,
 * and `lost` carries out a write and drops its answer.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REPOSITORY = 'acme/widgets'
export const TOKEN = 'stand-in-agent-token'
type User = { id: number; login: string; type?: string }
export const USERS = {
  alice: { id: 1, login: 'alice', type: 'User' }, agent: { id: 2, login: 'agent', type: 'Bot' }, bob: { id: 3, login: 'bob', type: 'User' },
  reviewer: { id: 4, login: 'review-runner', type: 'User' }, renovate: { id: 5, login: 'renovate', type: 'Bot' }, ghost: { id: -1, login: 'Ghost', type: 'User' },
  untyped: { id: 6, login: 'carol' },
} satisfies Record<string, User>
interface Issue {
  number: number; title: string; body: string; user: User; created: number; updated: number; locked: boolean; state: 'open' | 'closed'
  pull?: { head: string; base: string; merged?: number; closed?: number }; originalAuthor?: string
}
interface Comment { id: number; number: number; body: string; user: User; created: number; updated: number; originalAuthor?: string }
type Failure = { method: string; path: RegExp; mode: number | 'lost'; skip: number }

export async function standInGitea() {
  const dir = mkdtempSync(join(tmpdir(), 'gitea-'))
  const tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  const issues = new Map<number, Issue>()
  const comments: Comment[] = []
  const failures: Failure[] = []
  const requests: { method: string; path: string }[] = []
  let clock = Math.floor(Date.now() / 1000) * 1000, ids = 100
  let url = ''
  const time = (ms: number) => new Date(ms + 3600_000).toISOString().replace(/\.\d{3}Z$/, '+01:00')
  const page = (url: URL, items: unknown[], response: ServerResponse) => {
    const size = Math.min(Number(url.searchParams.get('limit') ?? 30), 2), at = (Number(url.searchParams.get('page') ?? 1) - 1) * size
    json(response, items.slice(at, at + size), { 'x-total-count': String(items.length) })
  }
  const json = (response: ServerResponse, value: unknown, headers: Record<string, string> = {}, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json', date: new Date(clock).toUTCString(), ...headers }).end(JSON.stringify(value))
  }
  const windowed = (url: URL) => {
    const since = Date.parse(url.searchParams.get('since') ?? '1970-01-01T00:00:00Z'), before = Date.parse(url.searchParams.get('before') ?? '2100-01-01T00:00:00Z')
    return (updated: number) => updated >= since && updated <= before
  }
  const htmlPage = (number: number, pr: boolean) => `${url}/${REPOSITORY}/${pr ? 'pulls' : 'issues'}/${number}`
  const issueJson = (issue: Issue) => ({ number: issue.number, title: issue.title, body: issue.body, user: issue.user, state: issue.state,
    original_author: issue.originalAuthor ?? '', created_at: time(issue.created), updated_at: time(issue.updated), html_url: htmlPage(issue.number, !!issue.pull),
    is_locked: issue.locked, pull_request: issue.pull ? { merged: !!issue.pull.merged } : null })
  const commentJson = (comment: Comment) => {
    const pr = !!issues.get(comment.number)?.pull
    return { id: comment.id, body: comment.body, user: comment.user, original_author: comment.originalAuthor ?? '', created_at: time(comment.created),
      updated_at: time(comment.updated), html_url: `${htmlPage(comment.number, pr)}#issuecomment-${comment.id}`,
      issue_url: pr ? '' : htmlPage(comment.number, false), pull_request_url: pr ? htmlPage(comment.number, true) : '' }
  }
  const pullJson = (issue: Issue) => {
    const pull = issue.pull!
    const branch = (ref: string) => ({ ref, sha: `sha-${ref}`, repo: { full_name: REPOSITORY } })
    return { number: issue.number, title: issue.title, body: issue.body, html_url: htmlPage(issue.number, true), user: issue.user, state: issue.state,
      merged: !!pull.merged, merged_at: pull.merged ? time(pull.merged) : null, closed_at: pull.closed ? time(pull.closed) : null,
      head: branch(pull.head), base: branch(pull.base) }
  }
  const touch = (number: number) => { issues.get(number)!.updated = clock }
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const method = request.method ?? 'GET'
      const address = new URL(request.url ?? '', 'http://stand-in')
      const path = address.pathname.replace(/^\/api\/v1/, '')
      requests.push({ method, path: `${path}${address.search}` })
      if (request.headers.authorization !== `token ${TOKEN}`) { json(response, { message: 'token is required' }, {}, 401); return }
      const matched = failures.find(item => item.method === method && item.path.test(path))
      const failure = matched && matched.skip-- <= 0 ? matched : undefined
      if (failure) failures.splice(failures.indexOf(failure), 1)
      if (typeof failure?.mode === 'number') { json(response, { message: 'injected' }, {}, failure.mode); return }
      const answer = (value: unknown, status = 200) => { if (failure?.mode === 'lost') response.socket?.destroy(); else json(response, value, {}, status) }
      const repo = `/repos/${REPOSITORY}`
      let match: RegExpExecArray | null
      if (path === '/version') json(response, { version: '28.3.0' })
      else if (path === '/user') json(response, { ...USERS.agent, email: 'agent@noreply.example.test' })
      else if (path === repo) json(response, { full_name: REPOSITORY, default_branch: 'main', permissions: { push: true } })
      else if (path === `${repo}/issues`) {
        const inWindow = windowed(address)
        page(address, [...issues.values()].filter(issue => inWindow(issue.updated)).map(issueJson), response)
      } else if (path === `${repo}/issues/comments`) {
        const inWindow = windowed(address)
        page(address, comments.filter(comment => inWindow(comment.updated)).map(commentJson), response)
      } else if ((match = /^\/repos\/acme\/widgets\/issues\/(\d+)$/.exec(path))) {
        const issue = issues.get(Number(match[1]))
        if (issue) json(response, issueJson(issue)); else json(response, { message: 'not found' }, {}, 404)
      } else if ((match = /^\/repos\/acme\/widgets\/issues\/(\d+)\/comments$/.exec(path))) {
        const number = Number(match[1]), issue = issues.get(number)
        if (!issue) json(response, { message: 'not found' }, {}, 404)
        else if (method === 'GET') {
          const all = comments.filter(comment => comment.number === number).map(commentJson)
          json(response, all, { 'x-total-count': String(all.length) })
        } else if (issue.locked) json(response, { message: 'locked' }, {}, 403)
        else {
          const comment = { id: ++ids, number, body: (JSON.parse(body) as { body: string }).body, user: USERS.agent, created: clock, updated: clock }
          comments.push(comment); touch(number)
          answer(commentJson(comment), 201)
        }
      } else if ((match = /^\/repos\/acme\/widgets\/pulls\/(\d+)$/.exec(path))) {
        const issue = issues.get(Number(match[1]))
        if (issue?.pull) json(response, pullJson(issue)); else json(response, { message: 'not found' }, {}, 404)
      } else if (path === `${repo}/pulls` && method === 'GET') {
        const poster = address.searchParams.get('poster'), base = address.searchParams.get('base_branch')
        page(address, [...issues.values()].filter(issue => issue.pull && (!poster || issue.user.login === poster) && (!base || issue.pull.base === base))
          .map(pullJson), response)
      } else if (path === `${repo}/pulls`) {
        const draft = JSON.parse(body) as { head: string; base: string; title: string; body: string }
        const open = [...issues.values()].some(issue => issue.state === 'open' && issue.pull?.head === draft.head && issue.pull.base === draft.base)
        if (open) { json(response, { message: 'pull request already exists' }, {}, 409); return }
        const number = stand.issue(USERS.agent, draft.title, draft.body, { head: draft.head, base: draft.base })
        answer(pullJson(issues.get(number)!), 201)
      } else if ((match = /^\/repos\/acme\/widgets\/raw\/(.+)$/.exec(path))) {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(`contents of ${decodeURIComponent(match[1]!)}`)
      } else if ((match = /^\/repos\/acme\/widgets\/contents\/(.*)$/.exec(path))) json(response, [{ name: 'src' }, { name: '.github' }, { name: 'README.md' }])
      else json(response, { message: 'not found' }, {}, 404)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const stand = {
    url, tokenFile, issues, comments, requests,
    get now() { return new Date(clock).toISOString() },
    /** Moves the server's clock on. */
    tick(seconds: number) { clock += seconds * 1000 },
    issue(user: User, title: string, body: string, pull?: { head: string; base: string }, originalAuthor?: string): number {
      const number = Math.max(0, ...issues.keys()) + 1
      issues.set(number, { number, title, body, user, created: clock, updated: clock, locked: false, state: 'open', ...pull ? { pull } : {},
        ...originalAuthor ? { originalAuthor } : {} })
      return number
    },
    comment(user: User, number: number, body: string, originalAuthor?: string): number {
      const comment = { id: ++ids, number, body, user, created: clock, updated: clock, ...originalAuthor ? { originalAuthor } : {} }
      comments.push(comment); touch(number)
      return comment.id
    },
    edit(id: number, body: string) { const comment = comments.find(item => item.id === id)!; comment.body = body; comment.updated = clock },
    close(number: number) { const issue = issues.get(number)!; issue.state = 'closed'; if (issue.pull) issue.pull.closed = clock; touch(number) },
    reopen(number: number) { const issue = issues.get(number)!; issue.state = 'open'; delete issue.pull?.closed; touch(number) },
    /** Merges without bumping the conversation's update time, which the Source must not rely on. */
    merge(number: number) { const issue = issues.get(number)!; issue.state = 'closed'; issue.pull!.merged = clock; issue.pull!.closed = clock },
    lock(number: number) { issues.get(number)!.locked = true },
    /** Breaks the matching request after `skip` matching ones went through. */
    fail(method: string, path: RegExp, mode: number | 'lost', skip = 0) { failures.push({ method, path, mode, skip }) },
    agentComments: (number: number) => comments.filter(comment => comment.number === number && comment.user === USERS.agent),
    async stop() { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }) },
  }
  return stand
}
export type StandInGitea = Awaited<ReturnType<typeof standInGitea>>
