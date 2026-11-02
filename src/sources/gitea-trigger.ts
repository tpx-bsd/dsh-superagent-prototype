/** The identities of a Gitea repository's records among Threads. */
import { repositoryKey, type GiteaConnection } from './gitea-api.ts'
import type { PullThreads } from './pull.ts'

export const SOURCE = 'gitea'
/** The Threads of one repository's Issues and pull requests, `gitea:<repository key>:<number>`, so another server or repository never shares them. */
export const giteaThreads = ({ server, repository }: Pick<GiteaConnection, 'server' | 'repository'>): PullThreads =>
  ({ source: SOURCE, scope: `${repositoryKey(server, repository)}:` })
