import { afterEach, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { giteaHost } from '../src/sources/gitea-host.ts'
import { giteaKind, pollFeed } from '../src/sources/gitea.ts'
import { repositoryKey } from '../src/sources/gitea-api.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { REPOSITORY, standInGitea, USERS, type StandInGitea } from './fixtures/gitea.ts'

vi.setConfig({ testTimeout: 30_000 })
let host: Host | undefined
let stand: StandInGitea | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await host?.stop()
  await stand?.stop()
  host = undefined
  stand = undefined
})

async function setup(supplied?: StandInGitea, directory?: string) {
  const g = stand = supplied ?? await standInGitea()
  const h = host = await startRuntime(store => {
    const settings = store.settings()
    store.saveSettings({ ...settings, sources: { ...settings.sources,
      gitea: { enabled: true, config: { url: g.url, repository: REPOSITORY, tokenFile: g.tokenFile } } } })
  }, giteaHost, directory)
  h.runtime.sources.register(giteaKind)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy,
    sources: { ...settings.policy.sources, gitea: { allowed: [{ id: 'alice' }] } } } })
  const original = h.runtime.context(giteaKind)
  const received: Trigger[] = []
  const ctx = { ...original, deployment: original.deployment, receive: async (trigger: Trigger) => {
    received.push(trigger)
    return original.receive(trigger)
  } }
  const poll = () => pollFeed(ctx, new AbortController().signal)
  const cursor = () => h.runtime.store.get(KV.gitea.cursor(repositoryKey(g.url, REPOSITORY)))
  return { h, g, ctx, poll, cursor, received }
}


async function saveBots(h: Host, bots: string[]) {
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, sources: { ...policy.sources,
    gitea: { allowed: [{ id: 'alice' }, { id: 'bob' }], bots: bots.map(id => ({ id })) } } },
    h.runtime.store.blockRevision('policy'), 'panel')
}
async function blockedTicket() {
  const s = await setup()
  await saveBots(s.h, [])
  await s.poll()
  s.g.tick(30)
  const number = s.g.issue(USERS.bob, 'Request', '@agent fix the login')
  s.g.tick(30)
  await s.poll()
  const { ticket, sessionId } = await s.h.acceptedTicket(s.received[0]!)
  await s.h.runTool(sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Need a person.' })
  const agent = s.h.agents.get(sessionId)!
  agent.status = 'idle'
  s.h.ctx.emit('agent/status', { agent, status: 'idle' } as never)
  await s.h.runtime.idle()
  await s.h.runtime.settings.pause(true, 'panel')
  s.g.tick(30)
  s.g.comment(USERS.alice, number, '@agent resume with the pending decision')
  s.g.tick(30)
  await s.poll()
  s.h.deliveries.mockClear()
  const pending = s.h.runtime.store.tickets.get(ticket.id)!.inputs.at(-1)!
  return { ...s, ticket, sessionId, number, pending }
}

async function holdResolution(h: Host, sessionId: string) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let held = false
  h.controller.resolveAgent.mockImplementation(async id => {
    if (id === sessionId && !held) { held = true; await gate }
    return h.resolveDefault(id)
  })
  const resume = h.runtime.settings.pause(false, 'panel')
  await vi.waitFor(() => expect(held).toBe(true))
  return { release, resume }
}

it('holds a revoked follow-up at the inbox boundary and releases its reserved worker slot', async () => {
  const { h, ticket, sessionId, pending } = await blockedTicket()
  const delayed = await holdResolution(h, sessionId)
  await saveBots(h, ['alice'])
  delayed.release()
  await delayed.resume
  await h.runtime.idle()
  expect(h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId)).toEqual([])
  expect(h.agents.get(sessionId)!.status).toBe('idle')
  const saved = h.runtime.store.tickets.get(ticket.id)!
  expect(saved.undelivered).toContain(pending.id)
  expect(saved.inputs.find(input => input.id === pending.id)).toEqual(pending)
  expect(saved.delivery).toBeUndefined()
  expect(h.runtime.health.worker?.state).not.toBe('error')
  expect(h.runtime.store.db.prepare("SELECT attempts, error FROM effect WHERE kind = 'delivery' AND key = ?").get(ticket.id))
    .toMatchObject({ attempts: 0, error: '' })
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, maxWorkers: 1 }, h.runtime.store.blockRevision('executor'), 'panel')
  const next = await h.acceptedTicket(feishu('next', '@bot fix a separate bug'))
  expect(h.agents.get(next.sessionId)!.status).toBe('running')
  expect(h.agents.get(sessionId)!.status).toBe('idle')
})

it('delivers held context and wakes the blocked worker when a current human follows up', async () => {
  const { h, g, poll, ticket, sessionId, number, pending } = await blockedTicket()
  const delayed = await holdResolution(h, sessionId)
  await saveBots(h, ['alice'])
  delayed.release()
  await delayed.resume
  await h.runtime.idle()
  expect(h.agents.get(sessionId)!.status).toBe('idle')
  g.tick(30)
  g.comment(USERS.bob, number, 'Continue with my decision.')
  g.tick(30)
  await poll()
  await h.runtime.idle()
  const delivered = h.deliveries.mock.calls.filter(([call]) => call.sessionId === sessionId)
  expect(delivered.filter(([call]) => call.text.includes('resume with the pending decision'))).toHaveLength(1)
  expect(delivered.filter(([call]) => call.text.includes('Continue with my decision.'))).toHaveLength(1)
  expect(h.agents.get(sessionId)!.status).toBe('running')
  const saved = h.runtime.store.tickets.get(ticket.id)!
  expect(saved.undelivered).toEqual([])
  expect(saved.inputs.find(input => input.id === pending.id)).toMatchObject(pending)
  expect(saved.delivery).toBeUndefined()
})

it('denies a stale bot the extra person slot while allowing a current human to wake its worker', async () => {
  const { h, g, ticket, sessionId, number, poll } = await blockedTicket()
  const executor = h.runtime.store.settings().executor
  await h.runtime.settings.save('executor', { ...executor, maxWorkers: 1 }, h.runtime.store.blockRevision('executor'), 'panel')
  await saveBots(h, ['alice'])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.idle()
  const other = await h.acceptedTicket(feishu('occupant', '@bot work on another request'))
  expect(h.agents.get(other.sessionId)!.status).toBe('running')
  expect(h.agents.get(sessionId)!.status).toBe('idle')
  expect(h.runtime.store.tickets.get(ticket.id)!.undelivered).not.toEqual([])
  g.tick(30)
  g.comment(USERS.bob, number, 'Continue with my decision.')
  g.tick(30)
  await poll()
  await h.runtime.idle()
  expect(h.agents.get(sessionId)!.status).toBe('running')
  expect(h.agents.get(other.sessionId)!.status).toBe('running')
  expect(h.runtime.executor.activeCount()).toBe(2)
  expect(h.runtime.store.tickets.get(ticket.id)!.undelivered).toEqual([])
})
