/** The GitHub binding of the repository host: the setup probes, the agent's git access to github.com, repository reads and pull request claims. */
import { z } from 'zod'
import { GithubAccountsSchema, executable, parsed, reason, type Machine, type Probe, type RepositoryAccess } from '../deployment.ts'
import { shellQuote, workerBin } from '../infra/environment.ts'
import { SetupError } from '../setup.ts'
import { claimPull, pullEndNotices, readPull } from './github-pull.ts'
import { readRepositoryPath } from './github-read.ts'
import { SOURCE } from './github-trigger.ts'
import type { RepositoryHost } from './host.ts'

const ORIGIN = 'https://github.com'
/** The git credential helper that answers with the agent CLI's own GitHub login. */
export const credentialHelper = (cli: string): string => `!${shellQuote(cli)} auth git-credential`

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryPermission = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
async function resolve(machine: Pick<Machine, 'stateDir'>, config: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<RepositoryAccess> {
  const accounts = GithubAccountsSchema.parse(config ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(machine.stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryPermission, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return {
    repository,
    account: { command: 'gh', cli, login: agent.login, commitEmail: `${agent.id}+${agent.login}@users.noreply.github.com` },
    git: { origin: ORIGIN, helper: credentialHelper(cli), insteadOf: ['git@github.com:', 'ssh://git@github.com/'] },
  }
}

export const githubHost: RepositoryHost = {
  source: { kind: SOURCE, health: ['github'] },
  resolve,
  readPath: readRepositoryPath,
  async pullClaim(ctx, ticketId, number, signal) {
    const pull = await readPull(ctx, number, signal)
    return () => claimPull(ctx, ticketId, pull)
  },
  pullEndNotices,
}
