import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GiteaApi, GiteaError, giteaServer } from '../src/sources/gitea-api.ts'
import { packagePath } from '../src/infra/paths.ts'

const exec = promisify(execFile)
const TOKEN = 'stand-in-token-0123456789'
let dir: string, server: Server, base: string, tokenFile: string
let answer: (request: IncomingMessage, url: URL, response: ServerResponse) => void
const seen: { path: string; authorization?: string; method?: string; body?: string }[] = []
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gitea-api-'))
  tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 })
  seen.length = 0
  server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const url = new URL(request.url ?? '', 'http://stand-in')
      seen.push({ path: `${url.pathname}${url.search}`, authorization: request.headers.authorization, method: request.method, ...body ? { body } : {} })
      answer(request, url, response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => { await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }) })
const api = () => GiteaApi.connect({ server: base, repository: 'acme/widgets', tokenFile })
const json = (response: ServerResponse, value: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(value))
}
const user = (login: string, type = 'User') => ({ id: login.length, login, type })
const comment = (id: number, at = '2026-11-02T10:29:34+01:00') => ({ id, body: `comment ${id}`, user: user('alice'), created_at: at, updated_at: at,
  html_url: `${base}/acme/widgets/issues/3#issuecomment-${id}`, issue_url: `${base}/acme/widgets/issues/3`, pull_request_url: '' })

describe('lists', () => {
  it('reads every page of a list whose server caps its pages, until X-Total-Count, with times in one form', async () => {
    answer = (_request, url, response) => {
      const page = Number(url.searchParams.get('page'))
      json(response, [comment(page * 2 - 1), comment(page * 2)].filter(item => item.id <= 5), { 'x-total-count': '5' })
    }
    const comments = await api().comments({ since: '2026-11-02T09:00:00.000Z', before: '2026-11-02T10:00:00.000Z' })
    expect(comments.map(item => item.id)).toEqual([1, 2, 3, 4, 5])
    expect(comments[0]).toMatchObject({ number: 3, isPr: false, createdAt: '2026-11-02T09:29:34.000Z', author: { login: 'alice', type: 'User' } })
    expect(seen.map(request => new URL(request.path, base).searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(new URL(seen[0]!.path, base).searchParams.get('before')).toBe('2026-11-02T10:00:00.000Z')
  })
  it('ends a list that ignores paging once a page holds nothing new, and one without a count at an empty page', async () => {
    answer = (_request, _url, response) => { json(response, [comment(1), comment(2), comment(3)]) }
    expect((await api().conversation(3)).map(item => item.id)).toEqual([1, 2, 3])
    expect(seen).toHaveLength(2)
    seen.length = 0
    answer = (_request, url, response) => { json(response, url.searchParams.get('page') === '1' ? [comment(1)] : []) }
    expect((await api().conversation(3)).map(item => item.id)).toEqual([1])
    expect(seen).toHaveLength(2)
  })
  it('skips and counts a malformed record, and classifies a missing or unknown user type as unknown', async () => {
    answer = (_request, _url, response) => {
      json(response, [comment(1), { id: 2 }, { ...comment(3), user: { id: 4, login: 'x' } }, { ...comment(4), user: { id: 5, login: 'y', type: 'Robot' } }],
        { 'x-total-count': '4' })
    }
    const tally = { skipped: 0 }
    const comments = await api().comments({ since: '2026-01-01T00:00:00.000Z', before: '2027-01-01T00:00:00.000Z' }, tally)
    expect(comments.map(item => [item.id, item.author.type])).toEqual([[1, 'User'], [3, 'unknown'], [4, 'unknown']])
    expect(tally.skipped).toBe(1)
  })
})

describe('requests', () => {
  it('sends the token only as the Authorization header, and reads it anew from the private file each time', async () => {
    answer = (_request, _url, response) => { json(response, { ...user('agent', 'Bot'), email: 'agent@example.test' }) }
    expect(await api().me()).toEqual({ id: 5, login: 'agent', type: 'Bot', email: 'agent@example.test' })
    expect(seen[0]).toEqual({ path: '/api/v1/user', authorization: `token ${TOKEN}`, method: 'GET' })
    writeFileSync(tokenFile, 'rotated-token\n')
    await api().me()
    expect(seen[1]!.authorization).toBe('token rotated-token')
  })
  it('refuses a token file other users may read before it sends anything', async () => {
    chmodSync(tokenFile, 0o644)
    answer = (_request, _url, response) => { json(response, {}) }
    await expect(api().me()).rejects.toThrow('group or other users may access it')
    expect(seen).toEqual([])
  })
  it('fails with the operation and status only, never the answer\'s body, and follows no redirect', async () => {
    answer = (_request, url, response) => {
      if (url.pathname.endsWith('/user')) response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ message: `bad token ${TOKEN}` }))
      else response.writeHead(302, { location: 'http://127.0.0.2:1/steal' }).end()
    }
    const failure = await api().me().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GiteaError)
    expect(failure).toMatchObject({ message: 'Gitea user: HTTP 401', code: 401, failure: 'status' })
    await expect(api().repository()).rejects.toMatchObject({ message: 'Gitea repository: HTTP 302', code: 302 })
    expect(seen.map(request => request.path)).toEqual(['/api/v1/user', '/api/v1/repos/acme/widgets'])
  })
  it('names a network failure and an unreadable answer apart from an HTTP status', async () => {
    answer = (_request, _url, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end('{"version":') }
    await expect(api().version()).rejects.toMatchObject({ message: 'Gitea version: unreadable answer', failure: 'malformed', code: undefined })
    const free = createServer()
    await new Promise<void>(resolve => free.listen(0, '127.0.0.1', resolve))
    const port = (free.address() as { port: number }).port
    await new Promise(resolve => free.close(resolve))
    const closed = GiteaApi.connect({ server: `http://127.0.0.1:${port}`, repository: 'acme/widgets', tokenFile })
    await expect(closed.version()).rejects.toMatchObject({ message: 'Gitea version: no answer (ECONNREFUSED)', failure: 'network' })
  })
  it('reports the server clock from the answer\'s Date with the version', async () => {
    answer = (_request, _url, response) => { json(response, { version: '28.3.0' }, { date: 'Mon, 02 Nov 2026 09:53:43 GMT' }) }
    expect(await api().version()).toEqual({ version: '28.3.0', at: '2026-11-02T09:53:43.000Z' })
  })
})

it('accepts a server URL only over https, or plain http on this machine, without credentials, and keeps its path', () => {
  expect(giteaServer('https://git.example.test/gitea/')).toBe('https://git.example.test/gitea')
  expect(giteaServer('http://127.0.0.1:63847')).toBe('http://127.0.0.1:63847')
  expect(() => giteaServer('http://git.example.test')).toThrow('https')
  expect(() => giteaServer('https://agent:secret@git.example.test')).toThrow('credentials')
  expect(() => giteaServer('https://git.example.test/?x=1')).toThrow('query')
  expect(() => giteaServer('git.example.test')).toThrow('not a URL')
})

describe('the git credential helper', () => {
  const helper = (input: string, scope = 'https://git.example.test:8443/gitea/acme/widgets.git') => new Promise<string>((resolve, reject) => {
    const child = execFile(process.execPath, [packagePath('src', 'sources', 'gitea-credential.ts'), scope, 'agent', tokenFile, 'get'],
      (error, stdout) => { if (error) reject(error); else resolve(stdout) })
    child.stdin!.end(input)
  })
  const request = (fields: Record<string, string>) => `${Object.entries(fields).map(([name, value]) => `${name}=${value}`).join('\n')}\n\n`
  const asked = { protocol: 'https', host: 'git.example.test:8443', path: 'gitea/acme/widgets.git' }
  it('answers only for the exact protocol, host, port and repository path', async () => {
    expect(await helper(request(asked))).toBe(`username=agent\npassword=${TOKEN}\n`)
    expect(await helper(request({ ...asked, path: 'gitea/acme/widgets' }))).toContain('password=')
    for (const other of [{ protocol: 'http' }, { host: 'git.example.test' }, { host: 'evil.example.test:8443' }, { path: 'gitea/acme/other.git' },
      { path: 'gitea/acme/widgets.git.evil' }, { path: '' }]) {
      expect(await helper(request({ ...asked, ...other }))).toBe('')
    }
  })
  it('answers store and erase with nothing, and refuses a token file other users may read', async () => {
    const run = (action: string) => exec(process.execPath, [packagePath('src', 'sources', 'gitea-credential.ts'), 'https://git.example.test/acme/widgets.git', 'agent', tokenFile, action])
    expect((await run('store')).stdout).toBe('')
    chmodSync(tokenFile, 0o640)
    await expect(helper(request(asked))).rejects.toThrow('group or other users may access it')
  })
})
