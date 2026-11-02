/**
 * The git credential helper of a Gitea deployment, which setup writes into the agent's git configuration: it answers `get` with the
 * agent's token, on git's pipe only, for the one repository URL it was written for, and nothing for any other protocol, host, port or path.
 * Arguments: that repository URL, the agent's login and the token file; git appends the action.
 */
import { readToken } from './gitea-token.ts'

const [scope = '', login = '', tokenFile = '', action] = process.argv.slice(2)
if (action === 'get') {
  let input = ''
  for await (const chunk of process.stdin) input += String(chunk)
  const fields = new Map(input.split('\n').flatMap(line => { const at = line.indexOf('='); return at > 0 ? [[line.slice(0, at), line.slice(at + 1)] as const] : [] }))
  const url = new URL(scope)
  const repository = url.pathname.slice(1).replace(/\.git$/, '')
  const path = fields.get('path') ?? ''
  const same = fields.get('protocol') === url.protocol.slice(0, -1) && fields.get('host') === url.host
    && (path === repository || path === `${repository}.git` || path.startsWith(`${repository}.git/info/lfs`))
  if (same) {
    try { process.stdout.write(`username=${login}\npassword=${readToken(tokenFile)}\n`) }
    catch (error) { process.stderr.write(`dsh-superagent: the Gitea token file ${tokenFile} cannot be used: ${(error as Error).message}\n`); process.exitCode = 1 }
  }
}
