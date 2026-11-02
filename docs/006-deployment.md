# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **A dedicated account on the repository host.** For GitHub, the agent uses a GitHub CLI signed in only as that account. For Gitea, it uses a private token file for direct HTTP and Git access. A Gitea-only deployment needs no GitHub account or credentials.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- One repository on github.com or Gitea. GitHub Enterprise Server is not supported. Keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if the repository uses Git LFS.
- For GitHub, GitHub CLI (`gh`) 2.48 or later. Its Source CLI field must point to a `gh` wrapper. Gitea uses direct HTTP and needs neither `gh` nor `tea`. Feishu CLI fields must point to `lark-cli` wrappers.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Agent Gitea account

1. Create a dedicated Gitea account and grant it write access to the repository. Both `User` and `Bot` agent accounts can authenticate. Human requesters must have API type `User`; see [002 Authorization](002-authorization.md#bots-and-automated-reviewers).
2. Create an access token as that account. It needs account and repository reads, Issue and PR conversation reads and writes, PR creation, and Git push access. Setup checks `/api/v1/version`, `/api/v1/user`, the repository, push permission, and a commit email. It does not exercise every write endpoint.
3. In your own terminal, save the token to a private file. This example reads it without echo or a shell argument:

   ```sh
   install -d -m 700 "$HOME/.config/dsh-superagent"
   python3 - <<'PYTOKEN'
   import getpass, os
   from pathlib import Path
   path = Path.home() / '.config/dsh-superagent/gitea-token'
   token = getpass.getpass('Gitea agent token: ')
   fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
   with os.fdopen(fd, 'w') as file:
       file.write(token.strip() + '\n')
   PYTOKEN
   ```

   Use a new path if the file already exists. The file must be regular, not a symlink, owned by the OS user running dsh-superagent, with no group or other permissions. `chmod 600` fixes its mode. Save only its absolute path in settings. Never put the token in a URL, prompt, execution variable, or command argument.
4. On the Gitea Source, set `url`, `repository` as `owner/name`, and `tokenFile`. Set nonsecret `commitEmail` if `/user` supplies no email or you need a different commit email. Setup resolves the account login from the token; there is no login setting.

The server URL must use HTTPS, except for `http://localhost`, `http://127.0.0.1`, or `http://[::1]`, with optional ports. Credentials, queries, and fragments in the URL are refused. A base subpath such as `https://git.example.org/gitea` is accepted and retained in API and Git URLs. Use the final address because API requests follow no redirects. Credential-helper tests cover a subpath and nondefault port; the controlled live check so far used a root URL.

The bundled Git credential helper matches protocol, host including port, and repository path, with or without `.git`. It also serves paths beginning with that repository's `.git/info/lfs`. It does not supply credentials to another repository. Use the explicit HTTPS clone URL, especially with a subpath or nondefault port.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

For GitHub, copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml). For Gitea, copy [examples/gitea.cordis.patch.yml](../examples/gitea.cordis.patch.yml), which selects `repositoryHost: gitea`, disables the GitHub plugin, and enables the Gitea plugin. Copy the chosen file to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `repositoryHost` | no | `github` by default, or `gitea`. Selects one repository host at startup; change the profile file and restart to switch |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit volatile machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** For GitHub, set the repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Gitea, enable its Source and set the server URL, repository, private token-file path, and commit email if needed. Its first poll establishes a cursor without reading earlier requests. Post a new mention after that poll. Later polls receive mentions and comments on subscribed conversations. Editing an old Issue description does not create a request. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the selected repository host's logins and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** Set the directory root and a prepare command. For GitHub:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   For Gitea, after setup has written `<stateDir>/worker-gitconfig`, create a local clone with that Git configuration. Replace the paths and URL with your own:

   ```sh
   GIT_CONFIG_GLOBAL=/home/me/.dsh/state/superagent/worker-gitconfig GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= \
     git clone https://git.example.org/acme/widgets.git /home/me/src/widgets
   ```

   Then save this prepare command. It runs in the worker environment, which already selects the scoped credential helper:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "$DSH_SUPERAGENT_GITEA_URL/$DSH_SUPERAGENT_GITEA_REPOSITORY.git" "${DSH_SUPERAGENT_GITEA_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLI wrappers as blocked commands. Gitea deployments already block `gh` and `tea` by name.
4. **Prompts.** Set disclosure, review bots, commit identity, and delivery requirements for the selected host. Gitea workers push with Git and open PRs through `orchestrator_report.pr_open`, not a CLI. Require people to merge. Git has no default commit identity; for Gitea, the default instructions use the agent login and `DSH_SUPERAGENT_GITEA_COMMIT_EMAIL` unless you name another author. An explicit commit can use:

   ```sh
   git -c user.name="$DSH_SUPERAGENT_GITEA_ACCOUNT" -c user.email="$DSH_SUPERAGENT_GITEA_COMMIT_EMAIL" commit -m "Fix the login"
   ```

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET settings` | `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`, `channelGone` or `channelIgnored` |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a Ticket, as the panel does |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `gitea`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:gitea`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli`, and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Gitea's config has `url`, `repository`, `tokenFile`, optional `commitEmail`, `pollSeconds` (30–3600, default 60), and `failuresBeforeError` (1–20, default 3). It has no receive-all or CI switches. Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `policy.sources.gitea` takes `allowed` and optional `bots`, each as `[{"id": "<login>"}]`. List ordinary Gitea automation accounts in `bots` to override human classification. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare` and `blockedCommands`. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing repository, CLI, or Gitea connection fields runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

For Gitea, the corresponding save uses `source:gitea`. Replace the example URL, repository, and file path. Keep tokens out of this request:

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' "$api/settings" | jq '.sources[] | select(.id == "gitea") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' "$api/settings/source:gitea" \
  -d "{\"value\":{\"enabled\":true,\"config\":{\"url\":\"https://git.example.org\",\"repository\":\"acme/widgets\",\"tokenFile\":\"/home/me/.config/dsh-superagent/gitea-token\",\"commitEmail\":\"agent@example.org\"}},\"revision\":$rev}"
```

## Setup checks

CLI and Git setup probes use the DeepSeek Harness subprocess service, as worker shells do. That service removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup resolves only the selected repository host, verifies the repository and the agent's push access, writes the worker environment, and checks that Git reads its credential configuration. Gitea uses direct HTTP for setup; GitHub and Feishu probes use subprocesses. Another installed repository Source stays inactive on the wrong host. A Feishu setup failure disables only the Feishu Source.

Setup rebuilds the resolved repository, accounts and git access on every start. These in-memory values do not change saved Source settings or the database schema. This repository-host refactor needs no data migration, including on rollback.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the GitHub agent's CLI, or fails along with `tea` on Gitea; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. For GitHub it selects the agent CLI as the github.com credential helper. For Gitea it selects the bundled helper with `useHttpPath` for the configured repository. SSH prefixes are rewritten to the configured HTTP or HTTPS base URL. The file also defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed account on the selected host, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Gitea, wait for the first poll before posting the request. For Feishu, mention the bot in a configured chat.

## Gitea version and API limits

Setup reads the server version and shows it on the Gitea Source card. The [recorded controlled HTTP and Git scenario](gitea-verification.json) has passed on Gitea **28.3.0**. Other versions display **an untested version**; passing setup alone does not establish compatibility. Internal-server validation remains deferred to issue #6.

The implementation covers Issue and PR descriptions, conversation comments, repository files, PR creation and adoption, and PR merge or close observation. It does not receive inline review comments, approvals, CI, notifications, or webhooks. It supplies no merge operation, multi-repository support, or GitHub-shaped Gitea CLI.

The repository Issues and comments APIs must honor `since` and `before`. The version endpoint must supply a parseable `Date` header for polling. Lists end at `X-Total-Count`, an empty page, or a page with no new records, never on a short page alone. Per-Issue comments on 28.3.0 return the complete conversation even when pagination is requested. The client reads that conversation before presenting pages of 20 to workers. A list exceeding 200 API pages fails as unreadable rather than truncating silently.

Setup reports malformed required responses and HTTP 405 as unsupported API behavior. A 404 from the version or account endpoint is unsupported; a repository 404 is reported as an unreadable repository. During polling and reply delivery, HTTP 404 remains retryable because lost access can also cause it. HTTP errors name the operation and status without remote response bodies. Network and malformed-response failures remain visible in setup or Source health.

## Controlled Gitea check

Run `tests/gitea-live.spec.ts` against a disposable Gitea server and repository. The test uses real HTTP and Git, with fixture DSH Sessions making the router and worker tool calls. It does not run a model or boot a real DSH profile.

The scenario creates the repository if absent, **makes it public**, grants the agent write access, pushes branches, creates comments and PRs, merges one PR as the owner, and closes another. Repeating the run adds new Issues and PRs. Use accounts and a repository reserved for this check.

1. Create a dedicated agent account, an owner account that can create a repository in its own namespace, and a separate unlisted account. The owner can also be the allowed requester. Set up the agent token file as described above. All accounts need usable API tokens; the agent needs an email returned by `/user` for this test.
2. Outside this checkout, create a private directory and a `people.json` file owned by the test user, with mode 600. Enter the owner, allowed requester, and stranger tokens there using a local editor. Do not paste tokens in chat or shell arguments. Its shape is:

   ```json
   {"users":{"pilot-owner":{"token":"<owner token>"},"pilot-stranger":{"token":"<stranger token>"}}}
   ```

3. In that directory, create `gitea-live.json` with paths and nonsecret configuration. Use your disposable server, accounts, and repository name:

   ```json
   {
     "url": "http://127.0.0.1:3000",
     "owner": "pilot-owner",
     "repository": "pilot-owner/superagent-check",
     "agentTokenFile": "/home/me/.config/dsh-superagent/gitea-token",
     "people": "/home/me/.config/dsh-superagent/people.json",
     "allowed": "pilot-owner",
     "stranger": "pilot-stranger",
     "evidence": "/home/me/.config/dsh-superagent/gitea-live-evidence.json"
   }
   ```

4. From this checkout, run:

   ```sh
   DSH_SUPERAGENT_GITEA_LIVE=/home/me/.config/dsh-superagent/gitea-live.json \
     pnpm_config_verify_deps_before_run=false pnpm exec vitest run tests/gitea-live.spec.ts
   ```

A passing run reports one passing test. Inspect the evidence JSON for the observed version, scoped Git helper, allowed and rejected intake, duplicate replay, pushed branch and adopted PR, restart cursor and follow-up, three original-conversation replies, and merged and closed Ticket outcomes. The test checks that the evidence contains none of its tokens. The JSON can be written after a failure, so use the test result as well as the evidence. Without the environment variable, this test is intended to be skipped by the normal suite.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| Gitea Source names no URL, repository, or token file | Fill the named field on the Gitea card; select `repositoryHost: gitea` and enable its plugin in the profile |
| `The Gitea token file … cannot be used` | Use an absolute regular-file path owned by the service user with mode 600; do not use a symlink |
| `Gitea … refuses the agent token (HTTP 401)` | Replace the token in the private file, then choose **Check again** |
| `Gitea forbids the agent token … (HTTP 403)` or cannot push | Grant the dedicated account and its token the required access; repository write access is required |
| `Gitea reports no email …` | Set nonsecret `commitEmail` on the Gitea card |
| `… does not answer the Gitea API's …` | Check the final base URL and version; unsupported or malformed endpoints fail setup. This does not confirm server compatibility |
| `Gitea … cannot be reached` | Check connectivity, TLS, and the operation detail; API requests do not follow redirects |
| Gitea shows **an untested version** | Run the controlled check on a disposable repository of that version before relying on it |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the credential configuration dsh-superagent writes for the repository host` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
