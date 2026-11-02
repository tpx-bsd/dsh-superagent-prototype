/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'
import { credentialHelper } from '../../src/sources/github-host.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
/** The GitHub account and git access of `cli`, as the GitHub repository host resolves them. */
export const githubAccess = (cli = '/bin/false', login = 'agent-bot', commitEmail = '7+agent-bot@users.noreply.github.com'): Pick<Deployment, 'account' | 'git'> => ({
  account: { command: 'gh', cli, login, commitEmail },
  git: { origin: 'https://github.com', helper: credentialHelper(cli), insteadOf: ['git@github.com:', 'ssh://git@github.com/'] },
})
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets', ...githubAccess(),
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  ...overrides,
})
