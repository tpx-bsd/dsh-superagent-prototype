import type { OutboundMessage } from '../core/index.ts'
import { sameName } from '../infra/text.ts'
import { GiteaApi, GiteaError } from './gitea-api.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'

/**
 * Posts a reply once: a hidden marker of the message's id in the comment lets a retry find the comment an earlier attempt posted,
 * also when that attempt's answer was lost. Only a deleted conversation (410), or a locked one, is `gone`; a 404 is retried, since
 * Gitea answers it as well while the agent lost access.
 */
export async function sendGitea(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { deployment } = host.commands
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing Gitea reply target')
  const api = GiteaApi.of(deployment)
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const posted = (await api.conversation(number)).some(comment => sameName(comment.author.login, deployment.account.login) && comment.body.includes(marker))
    if (!posted) await api.comment(number, `${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (error instanceof GiteaError && error.code === 410) return 'gone'
    if (error instanceof GiteaError && error.code === 403 && await api.issue(number).then(issue => issue.locked, () => false)) return 'gone'
    throw error
  }
}
export function giteaLink(address: Record<string, string>): ChannelLink {
  const number = address.number ?? ''
  return { url: address.url ?? `${address.server}/${address.repository}/issues/${number}`, label: { zh: `Gitea #${number}`, en: `Gitea #${number}` } }
}
