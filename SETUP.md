# SETUP

Instructions for an agent that sets up dsh-superagent with its operator. If you are a person, ask your coding agent to read this file and follow it.

## How to run the setup

The setup follows [docs/000-philosophy.md](docs/000-philosophy.md): it takes as little of the operator's attention as possible.

- **Before the first question,** read only this file and `docs/000-philosophy.md`, and run the probe below once. Read nothing else until every answer is collected.
- **Ask one question per message,** about one thing. Wait for the answer before the next one. Skip a question the probe already answers.
- **Keep each message under 300 words,** unless the operator asks for more. Give each question a recommended answer the operator can accept with one word, and one sentence on why it matters.
- **Do not execute while asking.** Collect every answer, then send one message with the full plan, and execute only after the operator confirms it.
- **Never ask for a secret in the chat.** Steps that need the operator's hands, such as creating an account, signing a CLI in or entering an app secret, go into one message with the exact commands to run in their own terminal.
- **Teach the philosophy through the questions,** one sentence at a time, not as a lecture.

## 1. Probe

Run from this checkout, once, and keep the result to yourself:

```sh
node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; dsh --version
gh api user --jq .login
command -v lark-cli
grep -l -E 'id: dsh-superagent\b' "${DSH_HOME:-$HOME/.dsh}"/profiles/*/cordis.patch.yml 2>/dev/null
```

- **Prerequisites:** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, and DSH within the `engines.dsh` range of `package.json`. GitHub additionally needs GitHub CLI 2.48+; Gitea needs no repository CLI. A missing prerequisite for the selected host becomes an item of the plan, not a question. DSH also needs a model provider; if the operator has never run DSH with a model, configuring one is an operator step.
- **Operator login:** for GitHub, the `gh api user` result is the operator's own login, used as the recommendation in question 5. A failed or missing `gh` is irrelevant for a Gitea-only deployment.
- **Existing profile:** a profile with a `dsh-superagent` entry is an earlier setup: ask whether to continue it, keep its configuration, and read Upgrade in `docs/006-deployment.md`.

## 2. Questions

Ask in this order, one per message, following the flow of work in [docs/001-domain.md](docs/001-domain.md): first where Triggers come from, then who may ask for work there, then what the Executor does with a Ticket. Recommendations are in brackets.

**Sources: where requests come from.**

1. **Repository host.** Is the repository on github.com or Gitea, and should the agent also take requests from Feishu chats? [Use the repository's host; add Feishu only if the team works there.]
2. **Repository.** Which repository should the agent work on, as `owner/name`? With Gitea, also collect the server base URL, including its subpath if present. HTTPS is required outside loopback.
3. **Agent account.** Which dedicated account on that host will the agent act as? [Use a separate account because its comments, pushes, and pull requests carry its identity.] Creating it is an operator step. GitHub requires a user account. With Gitea, collect only an absolute private token-file path, never the token. A dedicated `User` or `Bot` account can supply it.
4. With Feishu: **which chats,** by name? The agent looks up their ids after the bot is configured.

**Policy: who may ask for work.**

5. **On the repository host.** Which logins may ask the agent for work? [Only the operator's login while testing.] For Gitea, confirm that human requesters have positive-ID `User` accounts. Collect ordinary accounts used for automation in the existing `bots` list; that list overrides `User` classification.
6. With Feishu: **who may ask in Feishu?** [Everyone in the first chat, kept in sync with its members.]

**Execution: what the agent does with a Ticket.**

7. **Checkout.** Which local clone of the repository should each Ticket check out from? [A new clone under `~/src/<name>`.]
8. **Commit identity.** Who should the agent's commits name as author? [The agent account, so its work is visibly its own.] Another identity, such as the operator's, goes into the Delivery requirements prompt section.
9. **Auto-merge, GitHub only.** Should the agent enable auto-merge on its own pull requests once they are ready and approved? [No: people merge until the agent's pull requests have been right for a while.] The agent never enables it as the agent account, so with yes it needs the GitHub CLI of another account that may merge: ask the operator to sign one in among the operator steps, and name it in Delivery requirements. With no, remove the auto-merge paragraph from Delivery requirements. For Gitea, skip this question and require people to merge; no merge operation is supplied.

Do not ask about values with a good default; list them in the plan instead:

- profile `superagent`, a copy of DSH's Web profile kept apart from the profile the operator works in, so it restarts without closing their Sessions; port `3082`; state directory `<home>/.dsh/state/superagent` as an absolute path;
- an hourly check from the operator's own profile, which repairs dsh-superagent when it is not running;
- branch prefix `agent/`;
- accept mode `observe`, which records proactive work without doing it, and the default rules and prompt sections;
- with Feishu: the bot reads only mentions, and direct messages are on.

## 3. Plan

Send one message, under 300 words: what will be installed, the accounts and CLIs, the settings to save, the operator steps, and the defaults. Ask for one confirmation.

## 4. Execute

1. **Operator steps first.** Read Accounts in `docs/006-deployment.md`. For GitHub, write the wrappers, then ask the operator to create the account, accept its repository invitation, and run `auth login` for each wrapper. Check each with `<wrapper> api user --jq .login`. For Gitea, use Agent Gitea account there to create the private token file and grant write access. Setup resolves that identity through the API. For Feishu, ask the operator to create and publish the bot app and run `config init` with its secret. Send the operator steps together and wait until they are done.
2. **Install and start.** Follow the Install, Machine configuration, and Start and stop sections of `docs/006-deployment.md`. Skip the `git clone` of this repository: you are in its checkout. If question 7 asked for a new clone, clone it now for GitHub. For Gitea, use the post-setup clone command under Execution in the deployment guide after saving its Source. With an existing profile, skip the `dsh superagent --from-default-profile` command, which would replace the profile and delete its `cordis.patch.yml`, and edit that file instead of replacing it.
3. **Settings.** Save them through the Management API of `docs/006-deployment.md`, in this order: the selected `github` or `gitea` Source, the `feishu` Source if used, the `policy` block with the allowed lists, and the `executor` block with the host's prepare command. For Gitea, first set `repositoryHost: gitea` and enable its plugin using `examples/gitea.cordis.patch.yml`. Save `url`, `repository`, `tokenFile`, and `commitEmail` when needed on `source:gitea`. Put allowed people and automation accounts under `policy.sources.gitea`. GitHub settings and login are unnecessary. For Feishu, look up chat ids with the bot's CLI. Set the chosen commit identity in Delivery requirements. With Gitea, retain the default requirement that people merge. A save that returns `restarting: true` restarts dsh-superagent: wait until `scripts/dsh-superagent status` no longer exits 1 before the next request, and read the revisions again from `GET settings`.
4. **Failures.** A refused save names the setup problem in its response body. Find it in the Troubleshooting table of `docs/006-deployment.md`, fix it, and continue. Ask the operator only for what you cannot fix yourself.

## 5. Verify and hand over

`scripts/dsh-superagent status` exits 0 with no setup problem. If you run in the operator's own DSH profile, create the hourly check of the Hourly check section of `docs/006-deployment.md` with your schedule tool; otherwise give the operator its prompt to schedule there. Then send one message, under 300 words:

- The panel URL, and that the **Superagent** entry in the sidebar is where to look.
- How to try it: from an account on the allowed list, comment `@<agent login> <request>` on an issue in the repository. A Ticket appears on the overview within about a minute. With Gitea, wait for its first poll before posting; that poll establishes a baseline and does not read earlier requests.
- Three rules for the operator, from the Responsibility section of `docs/000-philosophy.md`: start narrow, tune for less noise, own what the agent says.
- Where to read more: the numbered documents in `docs/`, in order.
