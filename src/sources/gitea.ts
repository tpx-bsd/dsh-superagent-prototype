import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey, type Trigger } from '../core/index.ts'
import { GiteaAccountsSchema } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import { KV } from '../kv.ts'
import { GiteaApi, giteaConnection, giteaServer, repositoryKey, type GiteaConnection } from './gitea-api.ts'
import { giteaLink, sendGitea } from './gitea-channel.ts'
import { TESTED_VERSIONS } from './gitea-host.ts'
import { giteaThreadContext } from './gitea-read.ts'
import { authorOf, commentTrigger, giteaThread, giteaThreads, issueTrigger, SOURCE } from './gitea-trigger.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, polled, pollFailure } from './poll.ts'
import { observePull, pullsOf } from './pull.ts'

const GiteaConfigSchema = GiteaAccountsSchema.extend({ pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3) }).strict()
export type GiteaConfig = z.infer<typeof GiteaConfigSchema>
const Login = z.string().regex(/^[A-Za-z0-9_.-]+$/)
function configured(config: GiteaConfig): Pick<GiteaConnection, 'server' | 'repository'> | undefined {
  try { return config.repository ? { server: giteaServer(config.url), repository: config.repository } : undefined } catch { return undefined }
}
const sameRepository = (record: Record<string, unknown>, config: GiteaConfig): boolean => {
  const repository = configured(config)
  return !!repository && record.server === repository.server && sameName(String(record.repository ?? ''), repository.repository)
}

export const giteaKind: SourceKind<GiteaConfig> = {
  kind: SOURCE,
  title: { zh: 'Gitea', en: 'Gitea' },
  description: { zh: '智能体在 Gitea 上的账号；接收仓库里 @ 它的 Issue、PR 和评论，已订阅的 Issue 与 PR 的讨论，以及 PR 合并关闭。', en: 'The agent\'s Gitea account; receives Issues, pull requests and comments in the repository that mention it, discussion on subscribed Issues and pull requests, and pull request merge or close.' },
  schema: GiteaConfigSchema,
  fields: [
    { key: 'url', type: 'text', label: { zh: '服务器地址', en: 'Server URL' },
      hint: { zh: 'Gitea 的网址，例如 https://git.example.org，在子路径下时带上子路径。只在本机时可以用 http。保存时检查令牌和推送权限，然后重启 dsh-superagent。', en: 'Gitea\'s address, such as https://git.example.org, with its path when it is served under one. Plain http only on this machine. Saving checks the token and push access, then restarts dsh-superagent.' } },
    { key: 'repository', type: 'text', pattern: '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+', label: { zh: '仓库', en: 'Repository' },
      hint: { zh: '写作 owner/name。', en: 'Written owner/name.' } },
    { key: 'tokenFile', type: 'text', pattern: '/.*', label: { zh: '令牌文件', en: 'Token file' },
      hint: { zh: '智能体账号的访问令牌所在文件的绝对路径，只能由运行 dsh-superagent 的用户读取（chmod 600）。这里只保存路径，令牌只出现在请求头和 git 的凭据管道里。', en: 'Absolute path of the file holding the agent account\'s access token, readable only by the user running dsh-superagent (chmod 600). Only the path is saved; the token appears only in request headers and git\'s credential pipe.' } },
    { key: 'commitEmail', type: 'text', label: { zh: '提交邮箱', en: 'Commit email' },
      hint: { zh: '可选；Gitea 不报告智能体账号的邮箱时必须填写。', en: 'Optional; required when Gitea does not report the agent account\'s email.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  scope: ({ meta }, config) => sameRepository(meta, config) ? { listened: true, observed: false } : { listened: false, reason: 'repository_not_listened' },
  health: ['gitea'],
  channel: { allowed: sameRepository, send: sendGitea, link: giteaLink },
  threadContext: giteaThreadContext,
  find: (query, config) => {
    const repository = configured(config)
    const page = repository && new RegExp(`^${repository.server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/${repository.repository}/(?:issues|pulls)/(\\d+)`, 'i').exec(query.trim())
    const number = (/^#?(\d+)$/.exec(query.trim()) ?? page)?.[1]
    return { threads: repository && number ? [`${SOURCE}:${repositoryKey(repository.server, repository.repository)}:${number}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: Login }).strict()).default([]), bots: z.array(z.object({ id: Login }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gitea 账号', en: 'Gitea accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] },
    { key: 'bots', type: 'rows', label: { zh: '自动化账号', en: 'Automation accounts' },
      hint: { zh: 'Gitea 的 Bot 账号总按自动化处理。普通账号用于自动化（例如评审机器人）时列在这里：它们的评论从不算人的请求，@ 智能体时成为推断的候选，交给评估。', en: 'Gitea Bot accounts always count as automation. List ordinary accounts used for automation, such as review bots, here: their comments never count as a person\'s request, and become an inferred candidate for an assessment when they mention the agent.' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、PR 或评论里 @ 智能体的账号。', en: 'An account on the list mentions the agent\'s account in an Issue, a pull request or a comment.' },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITEA_URL', description: { zh: 'Gitea 服务器地址；仓库的 git 地址是 $DSH_SUPERAGENT_GITEA_URL/$DSH_SUPERAGENT_GITEA_REPOSITORY.git', en: 'The Gitea server\'s address; the repository\'s git URL is $DSH_SUPERAGENT_GITEA_URL/$DSH_SUPERAGENT_GITEA_REPOSITORY.git' } },
      { key: 'DSH_SUPERAGENT_GITEA_REPOSITORY', description: { zh: '这个来源监听的仓库，owner/name。从最后一段是 DSH_SUPERAGENT_NAME 的分支（例如 agent/$DSH_SUPERAGENT_NAME）推送，用 orchestrator_report 的 pr_open 开 PR', en: 'The repository this Source watches, as owner/name. Push a branch whose last path segment is DSH_SUPERAGENT_NAME (for example agent/$DSH_SUPERAGENT_NAME) and open its PR with orchestrator_report\'s pr_open' } },
      { key: 'DSH_SUPERAGENT_GITEA_ACCOUNT', description: { zh: '智能体的 Gitea 账号；git 以它推送，没有 Gitea CLI', en: 'The agent\'s Gitea account; git pushes as it, and there is no Gitea CLI' } },
      { key: 'DSH_SUPERAGENT_GITEA_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱。这里的 git 没有身份：按提示词写明的作者提交，没有写明时用智能体账号和这个邮箱', en: 'Commit email of the agent\'s account. git has no identity here: commit as the author these instructions name, or as the agent\'s account with this email when they name none' } },
      { key: 'DSH_SUPERAGENT_GITEA_NUMBER', description: { zh: '接下工单的 Issue 或 PR 编号；工单不是从 Gitea 来的时为空', en: 'Number of the Issue or PR that started the ticket; empty when the ticket did not start on Gitea' } },
      { key: 'DSH_SUPERAGENT_GITEA_PR_HEAD', description: { zh: '接下工单的 PR 的 head 引用 refs/pull/<编号>/head；不是 PR 时为空', en: 'Head ref refs/pull/<number>/head of the PR that started the ticket; empty when it was not a PR' } },
    ],
    values: ({ deployment, trigger }): Record<string, string> => {
      if (deployment.host !== SOURCE) return {}
      const { server, repository } = giteaConnection(deployment)
      const number = trigger?.source === SOURCE && trigger.meta.server === server ? Number(trigger.meta.number) || 0 : 0
      return { DSH_SUPERAGENT_GITEA_URL: server, DSH_SUPERAGENT_GITEA_REPOSITORY: repository, DSH_SUPERAGENT_GITEA_ACCOUNT: deployment.account.login,
        DSH_SUPERAGENT_GITEA_COMMIT_EMAIL: deployment.account.commitEmail, DSH_SUPERAGENT_GITEA_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GITEA_PR_HEAD: number && trigger?.meta.isPr === true ? `refs/pull/${number}/head` : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => {
    if (deployment?.host !== SOURCE) return {}
    const version = deployment.version ?? ''
    const tested = TESTED_VERSIONS.includes(version)
    return { tokenFile: { zh: `当前账号 @${deployment.account.login}`, en: `Current account @${deployment.account.login}` },
      url: tested ? `Gitea ${version}` : { zh: `Gitea ${version}，未经测试的版本`, en: `Gitea ${version}, an untested version` } }
  },
}
export const name = 'dsh-superagent-gitea'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(giteaKind), 'gitea: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, giteaKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gitea', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitea', health('paused', 'setupPending')); return }
  if (ctx.deployment.host !== SOURCE) { ctx.report('gitea', health('paused', 'notBound', { host: ctx.deployment.host })); return }
  while (!signal.aborted) {
    const config = ctx.config<GiteaConfig>(SOURCE)
    const at = new Date().toISOString()
    try {
      if (config) {
        const { received, skipped } = await pollFeed(ctx, signal)
        ctx.report('gitea', { state: 'ready', detail: `${received} messages received${skipped ? `; ${skipped} unreadable records skipped` : ''}`, at })
      } else ctx.report('gitea', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitea', failed)
    }
    await pause((ctx.config<GiteaConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

/**
 * One poll of the repository: the Issues, pull requests and comments that changed since the read position, up to the server's
 * time when the poll began, then each pull request an open Ticket follows, read directly so a merge that changes nothing else
 * still ends it. A record that mentions the agent, or that is on a subscribed Thread, is received; the agent's own are not. The
 * read position moves only after each of them was received, five seconds short of that time, so a record Gitea stamps late is
 * read again and its stable id makes it a duplicate. The first poll only sets the read position: earlier records are not read.
 */
export async function pollFeed(ctx: SourceContext, signal: AbortSignal): Promise<{ received: number; skipped: number }> {
  const connection = giteaConnection(ctx.deployment)
  const api = GiteaApi.of(ctx.deployment, signal)
  const cursor = KV.gitea.cursor(repositoryKey(connection.server, connection.repository))
  const { at: before } = await api.version()
  const through = ctx.state.get(cursor)
  if (!through) { ctx.state.set(cursor, before); return { received: 0, skipped: 0 } }
  const window = { since: cursorAt(through), before }
  const tally = { skipped: 0 }
  const issues = await api.issues(window, tally)
  const comments = await api.comments(window, tally)
  const agent = ctx.deployment.account.login
  const bots = z.array(z.object({ id: z.string() })).catch([]).parse(ctx.policy(SOURCE)?.bots ?? []).map(bot => bot.id)
  const watched = new Set(ctx.threads.subscribed(SOURCE).filter(thread => polled(ctx, thread)).map(thread => thread.key))
  const triggers: Trigger[] = []
  for (const issue of issues) {
    const author = authorOf(issue.author, issue.migrated, agent, bots)
    if (author.kind !== 'self' && issue.createdAt >= window.since) triggers.push(issueTrigger(connection, issue, author, agent))
  }
  for (const comment of comments) {
    const author = authorOf(comment.author, comment.migrated, agent, bots)
    if (author.kind !== 'self') triggers.push(commentTrigger(connection, comment, author, agent))
  }
  const received = triggers.filter(trigger => trigger.addressed || watched.has(threadKey(trigger.threads[0]!)))
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  for (const trigger of received) {
    if (signal.aborted) throw new Error('The Gitea Source stopped during the poll')
    await ctx.receive(trigger)
  }
  const threads = giteaThreads(connection)
  for (const issue of issues) {
    const thread = threadKey(giteaThread(connection, issue.number))
    ctx.threads.patch(thread, { title: issue.title })
    ctx.threads.describe(thread, { label: `#${issue.number} ${issue.title}`, url: issue.url, facts: { number: { value: `#${issue.number}` } } })
  }
  await pollPulls(ctx, api, [...issues.filter(issue => issue.isPr && sameName(issue.author.login, agent)).map(issue => issue.number),
    ...ctx.tickets.open().flatMap(ticket => pullsOf(ticket, threads, true))])
  ctx.state.set(cursor, before)
  return { received: received.length, skipped: tally.skipped }
}
/** Reads each pull request and applies the pull request rules; a failed read stays on its Thread and fails the poll once all were read. */
async function pollPulls(ctx: SourceContext, api: GiteaApi, numbers: number[]): Promise<void> {
  const connection = giteaConnection(ctx.deployment)
  const threads = giteaThreads(connection)
  const failures: string[] = []
  for (const number of new Set(numbers)) {
    const thread = threadKey(giteaThread(connection, number))
    try {
      observePull(ctx, threads, await api.pull(number))
      ctx.threads.patch(thread, { pollError: undefined })
    } catch (error) {
      failures.push(`#${number}: ${String(error)}`)
      ctx.threads.patch(thread, { pollError: String(error) })
    }
  }
  if (failures.length) throw new Error(`${failures.length} Gitea pull request reads failed: ${failures.slice(0, 3).join('; ')}`)
}
