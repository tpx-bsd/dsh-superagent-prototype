import { afterEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { githubHost } from '../src/sources/github-host.ts'
import type { RepositoryHost } from '../src/sources/host.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

const standIn = (refusal?: string) => ({ ...githubHost,
  resolve: vi.fn<RepositoryHost['resolve']>((...args) => githubHost.resolve(...args)),
  pullClaim: vi.fn<RepositoryHost['pullClaim']>(async () => () => refusal),
  pullEndNotices: vi.fn<RepositoryHost['pullEndNotices']>(() => []) })

it('resolves setup and registers the Source skills through the repository host it is given', async () => {
  const repository = standIn()
  h = await startRuntime(undefined, repository)
  expect(repository.resolve).toHaveBeenCalledOnce()
  expect(repository.resolve.mock.calls[0]![1]).toMatchObject({ repository: 'acme/widgets' })
  expect(h.runtime.deployment).toMatchObject({ repository: 'acme/widgets', account: { command: 'gh', login: 'agent-bot' } })
  expect(h.runtime.prompts.skills(h.runtime.prompts.current().config).map(([name]) => name)).toEqual(['feishu', 'github'])
})

it('claims a reported pull request through the host, and records nothing when the host refuses it', async () => {
  const repository = standIn('PR does not belong to this ticket (stand-in)')
  h = await startRuntime(undefined, repository)
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix the login'))
  h.deliveries.mockClear()
  const gh = vi.mocked(Commands.prototype.gh)
  gh.mockClear()
  const before = h.runtime.store.tickets.get(ticket.id)!
  await expect(h.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'pr open', pr_number: 42 }))
    .rejects.toThrow('PR does not belong to this ticket (stand-in)')
  expect(repository.pullClaim).toHaveBeenCalledWith(expect.objectContaining({ commands: expect.anything() }), ticket.id, 42, expect.any(AbortSignal))
  expect(gh).not.toHaveBeenCalled()
  const after = h.runtime.store.tickets.get(ticket.id)!
  expect(after).not.toHaveProperty('follows')
  expect(after.assignments).toEqual(before.assignments)
  await h.runtime.idle()
  expect(h.relays(h.runtime.masterId)).toEqual([])
})

it('asks the host for the end notices of a Ticket that ended', async () => {
  const repository = standIn()
  h = await startRuntime(undefined, repository)
  const { ticket, sessionId } = await h.acceptedTicket(feishu('1', '@bot fix the login'))
  await h.runTool(sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Already fixed upstream.' })
  expect(repository.pullEndNotices).toHaveBeenCalledWith(expect.objectContaining({ id: ticket.id, ended: expect.anything() }),
    expect.stringContaining('fix the login'), expect.objectContaining({ repository: 'acme/widgets' }))
})
