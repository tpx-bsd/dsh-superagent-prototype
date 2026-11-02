import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { SetupError } from '../src/setup.ts'
import { repositoryKey } from '../src/sources/gitea-api.ts'
import { giteaHost } from '../src/sources/gitea-host.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { gitEnv } from './fixtures/git.ts'
import { REPOSITORY, standInGitea, TOKEN, USERS, type StandInGitea } from './fixtures/gitea.ts'
import { testMachine } from './fixtures/deployment.ts'

vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let h: Host | undefined, gitea: StandInGitea | undefined
afterEach(async () => { await h?.stop(); h = undefined; await gitea?.stop(); gitea = undefined })

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
    // Workers have no gh or tea of their own: either would act as the operator.
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
    // The answer is lost and so is the look that follows it; a person closes the PR before the worker tries again.
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
