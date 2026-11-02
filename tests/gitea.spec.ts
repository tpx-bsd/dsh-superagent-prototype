import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { SetupError } from '../src/setup.ts'
import { GiteaApi, repositoryKey } from '../src/sources/gitea-api.ts'
import { giteaHost } from '../src/sources/gitea-host.ts'
import { giteaKind, pollFeed } from '../src/sources/gitea.ts'
import { sendGitea } from '../src/sources/gitea-channel.ts'
import { readGitea } from '../src/sources/gitea-read.ts'
import { apply as applyGithub } from '../src/sources/github.ts'
import { KV } from '../src/kv.ts'
import { threadKey, type Trigger } from '../src/core/index.ts'
import { settingsPolicy } from '../src/policy.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'
import { REPOSITORY, standInGitea, TOKEN, USERS, type StandInGitea } from './fixtures/gitea.ts'
import { testMachine } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let h: Host | undefined, gitea: StandInGitea | undefined
afterEach(async () => { vi.restoreAllMocks(); await h?.stop(); h = undefined; await gitea?.stop(); gitea = undefined })

const config = (stand: StandInGitea, overrides: Record<string, string> = {}) => ({ url: stand.url, repository: REPOSITORY, tokenFile: stand.tokenFile, ...overrides })
async function giteaRuntime() {
  const stand = gitea = await standInGitea()
  h = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { ...settings.sources, gitea: { enabled: true, config: config(stand) } } })
  }, giteaHost)
  return { h, gitea: stand, thread: (number: number) => `gitea:${repositoryKey(stand.url, REPOSITORY)}:${number}` }
}
const refusal = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error instanceof SetupError ? [error.place, error.code] : error)

describe('setup', () => {
  it('binds the configured repository through the agent token, and lets git use it only for that repository', async () => {
    const { h, gitea } = await giteaRuntime()
    const scope = `${gitea.url}/${REPOSITORY}.git`
    expect(h.runtime.deployment).toMatchObject({ host: 'gitea', repository: REPOSITORY, version: '28.3.0',
      account: { login: 'agent', commitEmail: 'agent@noreply.example.test', server: gitea.url, tokenFile: gitea.tokenFile },
      git: { origin: gitea.url, scope, insteadOf: ['git@127.0.0.1:', 'ssh://git@127.0.0.1/'] } })
    const gitconfig = readFileSync(workerGitConfig(h.directory), 'utf8')
    expect(gitconfig).toContain(`[credential "${scope}"]\n\thelper = `)
    expect(gitconfig).toContain('\tuseHttpPath = true')
    expect(gitconfig).not.toContain(TOKEN)
    const env = gitEnv({ GIT_CONFIG_GLOBAL: workerGitConfig(h.directory), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' })
    const fill = (url: string) => new Promise<string>(resolve => {
      const child = execFile('git', ['credential', 'fill'], { env, cwd: h.directory }, (_error, stdout) => { resolve(stdout) })
      child.stdin!.end(`url=${url}\n\n`)
    })
    expect(await fill(scope)).toContain(`password=${TOKEN}`)
    expect(await fill(`${gitea.url}/acme/other.git`)).not.toContain('password=')
    await expect(exec(join(workerBin(h.directory), 'gh'), ['pr', 'list'])).rejects.toMatchObject({ stderr: expect.stringContaining('this installation\'s repository is on Gitea') })
    await expect(exec(join(workerBin(h.directory), 'tea'), [])).rejects.toMatchObject({ code: 1 })
  })
  it('names what keeps the token, the account or the repository from working, on the Gitea card', async () => {
    const stand = gitea = await standInGitea()
    const resolve = (overrides: Record<string, string>) => refusal(giteaHost.resolve(testMachine(), config(stand, overrides), vi.fn()))
    expect(await resolve({ url: '' })).toEqual(['gitea', 'giteaUrlUnset'])
    expect(await resolve({ url: 'http://git.example.test' })).toEqual(['gitea', 'giteaUrlRefused'])
    expect(await resolve({ tokenFile: '' })).toEqual(['gitea', 'giteaTokenFileUnset'])
    expect(await resolve({ repository: 'acme/missing' })).toEqual(['gitea', 'giteaRepositoryUnreadable'])
    expect(await resolve({ url: `${stand.url}/sub` })).toEqual(['gitea', 'giteaUnsupported'])
    stand.fail('GET', /^\/user$/, 403)
    expect(await resolve({})).toEqual(['gitea', 'giteaForbidden'])
    chmodSync(stand.tokenFile, 0o644)
    expect(await resolve({})).toEqual(['gitea', 'giteaTokenFile'])
    chmodSync(stand.tokenFile, 0o600)
    writeFileSync(stand.tokenFile, 'revoked-token\n')
    expect(await resolve({})).toEqual(['gitea', 'giteaSignedOut'])
    const tokenFile = join(mkdtempSync(join(tmpdir(), 'token-')), 'token')
    writeFileSync(tokenFile, TOKEN, { mode: 0o600 })
    await stand.stop(); gitea = undefined
    expect(await resolve({ tokenFile })).toEqual(['gitea', 'giteaUnreachable'])
  })
})

describe('pull requests', () => {
  async function workerTicket() {
    const runtime = await giteaRuntime()
    const accepted = await runtime.h.acceptedTicket(feishu('1', '@bot fix the login'))
    const branch = `agent/${accepted.ticket.execution!.name}`
    const report = (args: Record<string, unknown>) => runtime.h.runTool(accepted.sessionId, 'orchestrator_report', { state: 'progress', summary: 'PR open', ...args })
    const created = () => runtime.gitea.requests.filter(request => request.method === 'POST' && request.path.endsWith('/pulls')).length
    return { ...runtime, ...accepted, branch, report, created }
  }
  it('opens the ticket\'s PR from its pushed branch once, binds it, and adopts it on every repeat', async () => {
    const { h, gitea, ticket, branch, report, created, thread } = await workerTicket()
    const first = await report({ pr_open: { branch, title: 'Fix the login', body: 'Fixes the login.' } })
    expect(first).toMatchObject({ reported: true, pr: { number: 1, state: 'open', url: `${gitea.url}/${REPOSITORY}/pulls/1` } })
    expect(gitea.issues.get(1)).toMatchObject({ user: USERS.agent, pull: { head: branch, base: 'main' } })
    expect(gitea.issues.get(1)!.body).toContain(`<!-- dsh-superagent:pull:${ticket.id} -->`)
    expect(h.runtime.store.tickets.get(ticket.id)!.follows).toEqual([{ thread: thread(1), own: true }])
    expect(await report({ pr_open: { branch, title: 'Fix the login', body: 'Again.' } })).toMatchObject({ pr: { number: 1 } })
    expect(created()).toBe(1)
  })
  it('opens one PR when two reports race', async () => {
    const { gitea, branch, report, created } = await workerTicket()
    const draft = { pr_open: { branch, title: 'Fix', body: 'Fix.' } }
    const results = await Promise.all([report(draft), report(draft)])
    expect(results.map(result => (result.pr as { number: number }).number)).toEqual([1, 1])
    expect([...gitea.issues.values()].filter(issue => issue.pull)).toHaveLength(1)
    expect(created()).toBe(2)
  })
  it('adopts a PR whose creation answer was lost, also once a person closed it, and never opens a second one', async () => {
    const { h, gitea, ticket, branch, report, created } = await workerTicket()
    gitea.fail('POST', /\/pulls$/, 'lost')
    expect(await report({ pr_open: { branch, title: 'Fix', body: 'Fix.' } })).toMatchObject({ pr: { number: 1, state: 'open' } })
    expect(h.runtime.store.tickets.get(ticket.id)!.follows).toHaveLength(1)
    const second = `${branch.split('/')[0]}/2/${ticket.execution!.name}`
    gitea.fail('POST', /\/pulls$/, 'lost')
    gitea.fail('GET', /\/pulls$/, 503, 1)
    await expect(report({ pr_open: { branch: second, title: 'Fix', body: 'Fix.' } })).rejects.toThrow('Gitea pull request creation: no answer')
    gitea.close(2)
    expect(await report({ pr_open: { branch: second, title: 'Fix', body: 'Fix.' } })).toMatchObject({ pr: { number: 2, state: 'closed' } })
    expect(created()).toBe(2)
    expect([...gitea.issues.values()].filter(issue => issue.pull)).toHaveLength(2)
  })
  it('refuses a branch of another ticket, both pr_open and pr_number, and another branch\'s PR, posting nothing', async () => {
    const { gitea, branch, report, created } = await workerTicket()
    await expect(report({ pr_open: { branch: 'agent/someone-else', title: 'Fix', body: '' } })).rejects.toThrow('last path segment is this ticket\'s name')
    await expect(report({ pr_open: { branch, title: 'Fix', body: '' }, pr_number: 1 })).rejects.toThrow('not both')
    const other = gitea.issue(USERS.agent, 'Other', 'Other.', { head: 'agent/other', base: 'main' })
    await expect(report({ pr_number: other })).rejects.toThrow('PR does not belong to this ticket')
    expect(created()).toBe(0)
  })
})

describe('the Gitea Source', () => {
  async function source(stand?: StandInGitea, directory?: string) {
    const owned = stand ?? (gitea = await standInGitea())
    h = await startRuntime(store => {
      const settings = store.settings()
      store.saveSettings({ ...settings, sources: { ...settings.sources, gitea: { enabled: true, config: config(owned) } } })
    }, giteaHost, directory)
    const host = h
    host.runtime.sources.register(giteaKind)
    const settings = host.runtime.store.settings()
    host.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
      sources: { ...settings.policy.sources, gitea: { allowed: [{ id: 'alice' }], bots: [{ id: 'review-runner' }] } } } })
    const received: Trigger[] = []
    const poll = (signal = new AbortController().signal, after?: () => void) => {
      const ctx = host.runtime.context(giteaKind)
      return pollFeed({ ...ctx, deployment: ctx.deployment, receive: async trigger => {
        received.push(trigger); const result = await ctx.receive(trigger); after?.(); return result
      } }, signal)
    }
    const key = repositoryKey(owned.url, REPOSITORY)
    const accept = async (trigger: Trigger) => {
      await host.runtime.idle()
      const result = await host.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix the login', worktree_name: 'fix-login', acknowledgement: 'On it.' })
      await host.runtime.idle()
      return host.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    }
    return { h: host, gitea: owned, poll, received, accept, cursor: () => host.runtime.store.get(KV.gitea.cursor(key)), thread: (number: number) => `gitea:${key}:${number}` }
  }
  it('takes an allowed person\'s mention as one explicit request, and gives no one else, nor the agent\'s own echo, a person\'s authority', async () => {
    const { h, gitea, poll, received, accept } = await source()
    gitea.issue(USERS.alice, 'Before', '@agent from before the Source started')
    gitea.tick(30)
    await poll()
    expect(received).toEqual([])
    gitea.tick(30)
    const request = gitea.issue(USERS.alice, 'Login broken', 'The login fails. @agent please fix it.')
    gitea.comment(USERS.bob, request, '@agent do something else')
    gitea.comment(USERS.agent, request, 'Echo of @agent')
    gitea.comment(USERS.renovate, request, '@agent bump everything')
    gitea.comment(USERS.reviewer, request, '@agent review says fix')
    gitea.comment(USERS.ghost, request, '@agent from a deleted account')
    gitea.comment(USERS.untyped, request, '@agent with no type')
    gitea.comment(USERS.alice, request, '@agent imported', 'alice-on-github')
    gitea.comment(USERS.alice, request, 'no mention, no subscription yet')
    gitea.tick(30)
    expect(await poll()).toEqual({ received: 7, skipped: 0 })
    expect(received.map(trigger => `${trigger.actor.id}:${trigger.human}:${trigger.addressed}`).sort()).toEqual(['Ghost:false:mention',
      'alice:false:mention', 'alice:true:mention', 'bob:true:mention', 'carol:false:mention', 'renovate:false:mention', 'review-runner:false:mention'])
    const policy = settingsPolicy(h.runtime.store.settings(), h.runtime.sources)
    const gate = (trigger: Trigger) => {
      const verdict = policy.gate(trigger, h.runtime.store.threads.get(threadKey(trigger.threads[0]!))!, [])
      return `${trigger.actor.id}:${verdict.admissible ? verdict.strength : verdict.reason}`
    }
    expect(received.map(gate).sort()).toEqual(['Ghost:not_human', 'alice:explicit', 'alice:not_human', 'bob:not_a_member', 'carol:not_human',
      'renovate:not_human', 'review-runner:inferred'])
    const origin = received.find(trigger => trigger.meta.kind === 'issue')!
    const ticket = await accept(origin)
    received.length = 0
    gitea.tick(1)
    await poll()
    expect(received.every(trigger => trigger.id === origin.id)).toBe(true)
    expect(h.runtime.store.tickets.list()).toHaveLength(1)
    await h.runtime.sendReplies()
    expect(gitea.agentComments(request).map(comment => comment.body)).toEqual(['Echo of @agent', expect.stringMatching(/^On it\.\n\n<!-- dsh-superagent:.+ -->$/)])
    expect(ticket.channels[0]).toMatchObject({ source: 'gitea', address: { server: gitea.url, repository: REPOSITORY, number: String(request) } })
  })
  it('keeps the read position through a poll that stopped or failed part-way, and reads what it missed once', async () => {
    const { h, gitea, poll, received, cursor } = await source()
    await poll()
    const start = cursor()
    gitea.tick(30)
    const first = gitea.issue(USERS.alice, 'One', '@agent one')
    const second = gitea.issue(USERS.alice, 'Two', '@agent two')
    gitea.tick(30)
    const controller = new AbortController()
    await expect(poll(controller.signal, () => { controller.abort() })).rejects.toThrow('stopped during the poll')
    expect(cursor()).toBe(start)
    gitea.fail('GET', /\/issues\/comments$/, 500, 1)
    gitea.comment(USERS.alice, first, '@agent and more')
    gitea.comment(USERS.alice, first, '@agent and more again')
    gitea.comment(USERS.alice, first, '@agent and once more')
    gitea.tick(30)
    await expect(poll()).rejects.toThrow('Gitea comments: HTTP 500')
    expect(cursor()).toBe(start)
    received.length = 0
    await poll()
    expect(cursor()).not.toBe(start)
    expect(new Set(received.map(trigger => trigger.id)).size).toBe(5)
    expect(received.map(trigger => trigger.meta.number).sort()).toEqual([first, first, first, first, second])
    await poll()
    expect(new Set(received.map(trigger => trigger.id)).size).toBe(5)
    expect(received.filter(trigger => h.runtime.engine.candidate(trigger.id)?.strength === 'explicit')).not.toHaveLength(0)
  })
  it('receives a new opening edited past a frozen window, while ignoring an older description', async () => {
    const { gitea, poll, received } = await source()
    const old = gitea.issue(USERS.alice, 'Old', '@agent old')
    gitea.tick(30)
    await poll()
    gitea.tick(30)
    const number = gitea.issue(USERS.alice, 'New', '@agent fix')
    gitea.tick(30)
    const fetch = globalThis.fetch
    let edited = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await fetch(...args)
      if (!edited && String(args[0]).endsWith('/api/v1/version')) {
        edited = true
        gitea.tick(1)
        for (const id of [old, number]) gitea.issues.get(id)!.updated = Date.parse(gitea.now)
      }
      return response
    })
    await poll()
    expect(received).toEqual([])
    gitea.tick(60)
    await poll()
    expect(received.map(trigger => trigger.meta.number)).toEqual([number])
    await poll()
    expect(new Set(received.map(trigger => trigger.id)).size).toBe(1)
  })
  it('rejects an abort during the final receive without committing the cursor', async () => {
    const { gitea, poll, cursor } = await source()
    await poll()
    const before = cursor()
    gitea.tick(30)
    gitea.issue(USERS.alice, 'Request', '@agent fix')
    gitea.tick(30)
    const controller = new AbortController()
    await expect(poll(controller.signal, () => controller.abort())).rejects.toThrow('stopped during the poll')
    expect(cursor()).toBe(before)
  })
  it('retries an unreported PR after its read fails without moving past it', async () => {
    const { h, gitea, poll, received, accept, cursor, thread } = await source()
    await poll()
    gitea.tick(30)
    gitea.issue(USERS.alice, 'Fix the login', '@agent fix the login')
    gitea.tick(30)
    await poll()
    const ticket = await accept(received[0]!)
    const before = cursor()
    gitea.tick(30)
    const number = gitea.issue(USERS.agent, 'Fix the login', 'The worker pushed this PR.', { head: `agent/${ticket.execution!.name}`, base: 'main' })
    gitea.tick(30)
    gitea.fail('GET', new RegExp(`/pulls/${number}$`), 500)
    await expect(poll()).rejects.toThrow('pull request reads failed')
    expect(cursor()).toBe(before)
    gitea.tick(30)
    await poll()
    expect(h.runtime.store.tickets.get(ticket.id)?.follows).toContainEqual({ thread: thread(number), own: true })
  })
  it('replies once when the answer to a posted reply was lost, retries a 404, and drops a reply to a deleted or locked conversation', async () => {
    const { h, gitea } = await source()
    const number = gitea.issue(USERS.alice, 'Login', '@agent fix')
    const message = { id: 'reply-1', text: 'Done.', kind: 'reply' as const,
      channel: { source: 'gitea', thread: 'gitea:x:1', address: { server: gitea.url, repository: REPOSITORY, number: String(number) } } }
    gitea.fail('POST', /\/comments$/, 'lost')
    await expect(sendGitea(h.runtime, message)).rejects.toThrow('Gitea comment: no answer')
    expect(await sendGitea(h.runtime, message)).toBe('sent')
    expect(gitea.agentComments(number)).toHaveLength(1)
    gitea.fail('GET', /\/comments$/, 404)
    await expect(sendGitea(h.runtime, { ...message, id: 'reply-2' })).rejects.toThrow('HTTP 404')
    gitea.fail('GET', /\/comments$/, 410)
    expect(await sendGitea(h.runtime, { ...message, id: 'reply-3' })).toBe('gone')
    gitea.lock(number)
    expect(await sendGitea(h.runtime, { ...message, id: 'reply-4' })).toBe('gone')
    expect(gitea.agentComments(number)).toHaveLength(1)
  })
  it('keeps its read position and the replies that wait across a restart, and routes a person\'s follow-up to the ticket', async () => {
    const first = await source()
    await first.poll()
    first.gitea.tick(30)
    const request = first.gitea.issue(USERS.alice, 'Login', '@agent fix the login')
    first.gitea.tick(30)
    await first.poll()
    first.gitea.fail('POST', /\/comments$/, 503)
    const ticket = await first.accept(first.received[0]!)
    await first.h.runtime.sendReplies()
    expect(first.gitea.agentComments(request)).toEqual([])
    const directory = first.h.directory
    await first.h.stop(true); h = undefined
    first.gitea.tick(30)
    first.gitea.comment(USERS.alice, request, 'Also the logout, please.')
    first.gitea.tick(30)
    const again = await source(first.gitea, directory)
    await again.poll()
    expect(again.received.filter(trigger => trigger.meta.kind === 'comment').map(trigger => trigger.text)).toEqual(['Also the logout, please.'])
    expect(again.h.runtime.store.triggers.disposition(again.received.find(trigger => trigger.meta.kind === 'comment')!.id)?.fanout).toEqual([ticket.id])
    expect(again.h.runtime.store.tickets.list()).toHaveLength(1)
    await vi.waitFor(async () => { await again.h.runtime.sendReplies(); expect(first.gitea.agentComments(request)).toHaveLength(1) }, { timeout: 20_000 })
  })
  it('ends the ticket when a person merges or closes its pull request, read directly every poll, and never merges itself', async () => {
    const { h, gitea, poll, received, accept, thread } = await source()
    await poll()
    gitea.tick(30)
    gitea.issue(USERS.alice, 'One', '@agent one')
    gitea.issue(USERS.alice, 'Two', '@agent two')
    gitea.tick(30)
    await poll()
    const [one, two] = [await accept(received[0]!), await accept(received[1]!)]
    for (const ticket of [one, two]) {
      await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'progress', summary: 'PR open',
        pr_open: { branch: `agent/${ticket.execution!.name}`, title: ticket.title, body: 'Fix.' } })
    }
    const pulls = [one, two].map(ticket => h.runtime.store.tickets.get(ticket.id)!.follows![0]!.thread)
    expect(pulls).toEqual([thread(3), thread(4)])
    gitea.tick(30)
    gitea.merge(3)
    gitea.close(4)
    gitea.tick(30)
    await poll()
    expect(h.runtime.store.tickets.get(one.id)!.ended).toMatchObject({ outcome: 'merged' })
    expect(h.runtime.store.tickets.get(two.id)!.ended).toMatchObject({ outcome: 'closed' })
    expect(gitea.requests.filter(request => request.method !== 'GET' && !/\/(pulls|comments)$/.test(request.path))).toEqual([])
  })
  it('reads conversations for assessments and workers, page by page, marking accounts that are no person', async () => {
    const { h, gitea } = await source()
    const number = gitea.issue(USERS.alice, 'Login', '@agent fix')
    for (let index = 0; index < 21; index++) gitea.comment(index ? USERS.alice : USERS.renovate, number, `comment ${index}`)
    const api = GiteaApi.of(h.runtime.deployment)
    expect(await readGitea(api, `gitea/issues/${number}`)).toMatchObject({ number, title: 'Login', state: 'open', from: 'alice', text: 'Login\n\n@agent fix' })
    const page = await readGitea(api, `gitea/issues/${number}/comments/1`) as { messages: { from: string; bot?: true }[]; next_resource: string }
    expect(page.messages).toHaveLength(20)
    expect(page.messages[0]).toMatchObject({ from: 'renovate', bot: true })
    expect(page.next_resource).toBe(`gitea/issues/${number}/comments/2`)
    expect(await readGitea(api, page.next_resource)).toEqual({ messages: [expect.objectContaining({ text: 'comment 20' })] })
    await expect(h.runtime.sources.find(`${gitea.url}/${REPOSITORY}/issues/${number}`).threads).toEqual([`gitea:${repositoryKey(gitea.url, REPOSITORY)}:${number}`])
  })
  it('gives tickets the Gitea variables and no GitHub ones, and leaves a GitHub Source on this host inactive', async () => {
    const { h, gitea, poll, received, accept } = await source()
    await poll()
    gitea.tick(30)
    gitea.issue(USERS.alice, 'Login', '@agent fix')
    gitea.tick(30)
    await poll()
    const ticket = await accept(received[0]!)
    const values = Object.fromEntries(h.runtime.ticketEnvironment(ticket).map(variable => [variable.key, variable.value]))
    expect(values).toMatchObject({ DSH_SUPERAGENT_GITEA_URL: gitea.url, DSH_SUPERAGENT_GITEA_REPOSITORY: REPOSITORY, DSH_SUPERAGENT_GITEA_ACCOUNT: 'agent',
      DSH_SUPERAGENT_GITEA_NUMBER: '1', DSH_SUPERAGENT_GITEA_PR_HEAD: '' })
    expect(Object.values(values).join('\n')).not.toContain(TOKEN)
    expect(Object.entries(values).filter(([name, value]) => name.startsWith('DSH_SUPERAGENT_GITHUB_') && value)).toEqual([])
    applyGithub({ orchestrator: { sources: { register: () => () => {} }, context: (kind: never) => h.runtime.context(kind) }, effect: (effect: () => unknown) => { effect() } } as never)
    await vi.waitFor(() => expect(h.runtime.health.github).toMatchObject({ state: 'paused', code: 'notBound', values: { host: 'gitea' } }))
  })
})
