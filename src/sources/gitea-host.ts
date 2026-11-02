/** `giteaHost`, the Gitea `RepositoryHost`: setup checks of the agent's token and push access, its git access, repository reads and pull requests. */
import { existsSync } from 'node:fs'
import { liveTicket } from '../core/index.ts'
import { GiteaAccountsSchema, reason, type Machine, type RepositoryAccess } from '../deployment.ts'
import { shellQuote } from '../infra/environment.ts'
import { packagePath } from '../infra/paths.ts'
import { SetupError } from '../setup.ts'
import { GiteaApi, GiteaError, giteaConnection, giteaServer, type GiteaPull } from './gitea-api.ts'
import { readToken } from './gitea-token.ts'
import { giteaThreads, SOURCE } from './gitea-trigger.ts'
import type { RepositoryHost } from './host.ts'
import { agentPull, claimPull, pullEndNotices, ticketBranch } from './pull.ts'

/** The Gitea versions a controlled check ran against; setup reports any other as untested rather than refusing it. */
export const TESTED_VERSIONS: readonly string[] = ['28.3.0']
/** The bundled helper: the built file of an installed package, else its source in a checkout, which node runs as it is. */
const helperScript = (): string => {
  const built = packagePath('lib', 'gitea-credential.js')
  return existsSync(built) ? built : packagePath('src', 'sources', 'gitea-credential.ts')
}
/** The git credential helper that answers with the agent's token only for the repository URL `scope`. */
export const credentialHelper = (scope: string, login: string, tokenFile: string): string =>
  `!${[process.execPath, helperScript(), scope, login, tokenFile].map(shellQuote).join(' ')}`
/** The marker in the description of the pull request a Ticket opened, which finds it again in any state. */
const pullMarker = (ticketId: string): string => `<!-- dsh-superagent:pull:${ticketId} -->`

/** A setup problem for a failed request, placed on the Gitea card, as specific as its status allows. */
function setupProblem(error: unknown, url: string): SetupError {
  if (error instanceof SetupError) return error
  if (!(error instanceof GiteaError)) return new SetupError('giteaUnreachable', { url, output: reason(error) })
  if (error.code === 401) return new SetupError('giteaSignedOut', { url })
  if (error.code === 403) return new SetupError('giteaForbidden', { operation: error.operation })
  if (error.failure === 'malformed' || error.code === 404 || error.code === 405) {
    return new SetupError('giteaUnsupported', { url, operation: error.operation, output: error.message })
  }
  return new SetupError('giteaUnreachable', { url, output: error.message })
}
async function resolve(_machine: Pick<Machine, 'stateDir'>, config: unknown): Promise<RepositoryAccess> {
  const accounts = GiteaAccountsSchema.parse(config ?? {})
  if (!accounts.url) throw new SetupError('giteaUrlUnset')
  let server: string
  try { server = giteaServer(accounts.url) } catch (error) { throw new SetupError('giteaUrlRefused', { url: accounts.url, reason: reason(error) }) }
  if (!accounts.repository) throw new SetupError('giteaRepositoryUnset')
  if (!accounts.tokenFile) throw new SetupError('giteaTokenFileUnset')
  try { readToken(accounts.tokenFile) } catch (error) { throw new SetupError('giteaTokenFile', { file: accounts.tokenFile, reason: reason(error) }) }
  const api = GiteaApi.connect({ server, repository: accounts.repository, tokenFile: accounts.tokenFile })
  const failed = (error: unknown): never => { throw setupProblem(error, server) }
  const { version } = await api.version().catch(failed)
  const agent = await api.me().catch(failed)
  const repository = await api.repository().catch((error: unknown) => {
    if (error instanceof GiteaError && error.code === 404) throw new SetupError('giteaRepositoryUnreadable', { account: agent.login, repository: accounts.repository })
    return failed(error)
  })
  if (!repository.push) throw new SetupError('giteaRepositoryReadOnly', { account: agent.login, repository: repository.fullName })
  const commitEmail = accounts.commitEmail || agent.email
  if (!commitEmail) throw new SetupError('giteaNoCommitEmail', { account: agent.login })
  const scope = `${server}/${repository.fullName}.git`
  const { hostname } = new URL(server)
  return {
    host: 'gitea', repository: repository.fullName, version,
    account: { login: agent.login, commitEmail, server, tokenFile: accounts.tokenFile },
    git: { origin: server, scope, helper: credentialHelper(scope, agent.login, accounts.tokenFile), insteadOf: [`git@${hostname}:`, `ssh://git@${hostname}/`] },
  }
}

export const giteaHost: RepositoryHost = {
  source: { kind: SOURCE, health: ['gitea'] },
  resolve,
  async readPath(commands, path, kind) {
    const parts = path.split('/').filter(part => part && part !== '.')
    if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) throw new Error('Only non-hidden repository source paths are available')
    const api = GiteaApi.of(commands.deployment)
    if (kind === 'file') return api.file(parts.join('/'))
    return (await api.directory(parts.join('/'))).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
  },
  async pullClaim(ctx, ticketId, number, signal) {
    const pull = await GiteaApi.of(ctx.deployment, signal).pull(number)
    return () => claimPull(ctx, giteaThreads(giteaConnection(ctx.deployment)), ticketId, pull)
  },
  /**
   * Finds the pull request this Ticket opened from the branch, in any state, by the marker its description carries, and opens it
   * only when there is none. A conflict, or a request whose answer was lost, looks again before it fails, so a retry adopts what
   * an earlier attempt created and never opens a second one, even after a person closed the first.
   */
  async openPull(ctx, ticketId, draft, signal) {
    const ticket = ctx.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) throw new Error('Ticket ended; do not open a pull request for it')
    if (!ticketBranch(ticket, draft.branch)) {
      throw new Error(`pr_open.branch must be the pushed branch whose last path segment is this ticket's name, ${ticket.execution?.name ?? ''}, such as agent/${ticket.execution?.name ?? '<name>'}`)
    }
    const api = GiteaApi.of(ctx.deployment, signal)
    const { defaultBranch } = await api.repository()
    const marker = pullMarker(ticketId)
    const opened = async (): Promise<GiteaPull | undefined> => (await api.pulls(ctx.deployment.account.login, defaultBranch))
      .filter(pull => pull.head.ref === draft.branch && agentPull(pull, ctx.deployment) && pull.body.includes(marker))
      .sort((a, b) => b.number - a.number)[0]
    const pull = await opened() ?? await api.createPull({ head: draft.branch, base: defaultBranch, title: draft.title, body: `${draft.body}\n\n${marker}` })
      .catch(async (error: unknown) => {
        const unsettled = error instanceof GiteaError && (error.failure !== 'status' || error.code === 409 || error.code === 422 || error.code! >= 500)
        const found = unsettled ? await opened().catch(() => undefined) : undefined
        if (found) return found
        throw error
      })
    return { pull, claim: () => claimPull(ctx, giteaThreads(giteaConnection(ctx.deployment)), ticketId, pull) }
  },
  pullEndNotices(ticket, request, deployment) {
    const connection = giteaConnection(deployment)
    return pullEndNotices(giteaThreads(connection), number => `${connection.server}/${connection.repository}/pulls/${number}`, ticket, request)
  },
}
