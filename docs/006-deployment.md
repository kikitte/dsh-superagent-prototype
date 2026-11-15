# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **Optional: an agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Deployment for optional GitHub access, Sources for intake and Feishu bot configuration, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Base: Node.js 24.9+, pnpm, writable state directory and supported DSH with a configured model. Operational scripts additionally use Python 3.8+, tmux and a shell. Keep DSH's own prerequisites separate from Superagent's checks.
- Plain-file execution: no Git or GitHub CLI is required by Superagent. A zero-Source installation starts ready and idle; enable a Source to receive requests.
- Local Git: Git and an explicit author for requested commits (`executor.gitAuthor`), or the suggested identity of a ready GitHub integration.
- Optional GitHub: Git 2.32+, `gh` 2.48+, a dedicated agent account with push access to one github.com repository. GitHub Enterprise Server is not supported. LFS is needed only for repositories using it.
- Completed-Ticket execution after reopen and restart recovery, including default directories: a production durable process-owner provider covering hooks and all worker descendants, with independently verified quiescence. This bundle ships no production process-owner provider; these lifecycle checks remain blocked. Fixed inventory also requires authoritative cross-runtime occupancy/admission integration.
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
npm install -g @deepseek-ai/dsh@0.2.2-rc.3
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration and, by default, the Ticket directories in `work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

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

1. **Deployment and Sources.** For GitHub, enable access in Deployment and set repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Separately enable its Source for intake and PR observation. Both default off. Feishu-only operators skip GitHub accounts entirely. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** Configure the reserved `default` pool's root and prepare command. It creates one fresh dedicated execution directory at first launch, not an existing-directory inventory; retries and resumption retain the committed directory. To give each Ticket an independent checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   The default prepare hook runs in the root while the reserved target path is absent. It must create that exact path without clobbering and produce an independent checkout/worktree (as above), or a genuinely non-Git directory. It must not operate on an inherited ancestor checkout. An empty hook exclusively creates an empty directory. A committed target is never silently substituted after a crash or filesystem conflict. List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team scope and delivery requirements for the assigned artifact. Configure local commit identity in Execution. GitHub review/merge rules live in the conditional GitHub skill; custom prompt text is preserved and should be reviewed if it requests unavailable capabilities.

### Fixed-inventory pools and safety prerequisites

Execution settings also support optional fixed-inventory pools. Add a stable pool ID (anything but reserved `default`), a semantic description, absolute directory registrations with globally unique stable IDs, and operator-owned `prepare`/`recycle` hooks. Empty inventory is valid: accepted Tickets wait for that pool, without falling back to `default`. Write **Pool-selection instructions** separately from shell hooks and authorization rules. The main Session sees only these instructions, IDs/descriptions and their opaque version; it never selects paths or uses availability to choose a pool.

Registration and its removal have no filesystem effects. Saving rejects canonical aliases and ancestor/descendant overlaps, including symlink aliases and canonical parents of not-yet-created paths. Sibling registrations within one Git working tree may coexist, but the resolved working-tree resource has only one unreleased owner across every pool; distinct linked worktrees have distinct resources. Do not register dedicated `default` paths as inventory. A previously used directory ID/path/pool cannot be repointed; retire the registration and create a new ID. Retained affinity and history survive retirement. Open selected Tickets and unreleased leases prevent pool removal; unreleased or recovery-fenced directory leases prevent registration removal and executable-hook changes.

Fixed preparation runs for each acquired lease and must preserve unknown contents; recycling must preserve required Ticket state before making the workspace reusable. An empty hook grants no permission to discard changes or skip checks. Staged, unstaged, untracked, conflicted, dirty-submodule or unfinished-operation state prevents Git acquisition/reuse. Failed or unknown probes are not clean. Never automatically clean, stash, commit or delete pre-existing changes to obtain eligibility. Ticket-owned edits under the same unreleased lease do not block ordinary continuation. Release waits for verified stopped activity, successful preservation/recycling and clean-for-reuse checks; it does not delete the filesystem directory. A resumed Ticket reacquires its original directory, even if another one is available.

**Current fixed-inventory execution is fail-closed unless an authoritative cross-Session observation and coordinated-admission adapter is installed.** DSH `0.2.2-rc.3` running/workspace summaries alone do not prove live client Session-view presence or serialize conflicting Session starts, workspace changes and view openings. The operator diagnostics report `unknown`/unusable when that support is absent; an empty Session registry or a read-only refresh is not clearance. Actual displayed views across every browser tab/client, running Sessions, and outstanding jobs/descendants must all participate. Unknown presence after startup, disconnect or missed updates stays unknown until authoritatively reconciled. Never close unrelated views or stop external work to obtain a directory.

The allocator and Git resource claims coordinate **one state database**, not every DSH installation. Sharing fixed directories or their working trees with other profiles/processes/installations is unsupported without a shared authoritative observation/admission mechanism covering all of them; reject that topology rather than assuming other runtimes are idle. Dedicated `default` directories are not shared inventory. External Session presence/Git-clean-for-reuse checks do not block `default`, including a main Session displayed at its state root/ancestor; independent Git identity, ownership, filesystem and recovery safeguards still apply.

Restart dispatch additionally requires an external supervisor/OS process owner containing **all** managed subprocess descendants, including prepare/recycle hooks, and evidence that the prior execution range is empty; a supported durable process-owner mechanism can provide equivalent proof. Lost handles, no process-local jobs, time passing, or the host process exiting are not such proof. Without verified quiescence, unreleased directories remain quarantined, retaining ownership and affinity without worker slots. An operator must establish and record verified process cleanup and reconcile interrupted filesystem effects before recovery; registration or refresh is not remediation evidence.

To recheck process recovery after the supervisor has completed verified cleanup, open Settings → Execution → Directory diagnostics, inspect the lease's epoch and recorded process owner, then use **Recheck recovery evidence**. The equivalent management request is `POST directory-leases/<lease id>/recheck-recovery` with `{"executionEpoch":"<epoch from GET directories>"}`. It returns `{"cleared":false,"detail":"…"}` if the trusted provider/owner/proof is unavailable; ownership remains quarantined. Do not submit an evidence string or a force flag: the strict request schema rejects them. A stale lease/epoch or a change while verification runs returns HTTP 409; refresh diagnostics before retrying. On `cleared:true`, only the Executor scheduler is woken; ordinary admission, Git identity and preparation checks still apply, and normal preparation or release may proceed. Interrupted/failed hooks remain fenced against replay and require separate filesystem-effect reconciliation, for which this bundle has no operator workflow yet. The bundle still ships no production process-owner provider, so the recheck action alone cannot enable automatic recovery.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `src/app/api.ts` serve the panel and change with it.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; and `masterId` |
| `GET directories` | Read-only diagnostic snapshot: canonical directory records, current lease owner/lifecycle/preparation/recovery, Git evidence, external Session occupancy and blockers. Missing observation/admission support is `unknown`, not clear; no lease does not imply eligibility |
| `POST directories/refresh` | Refreshes the same read-only probes, wakes the Executor scheduler and requests a pass; it does not create/clean files or assert eligibility. The Executor rechecks before admission |
| `POST directory-leases/<id>/recheck-recovery` with `{"executionEpoch":"…"}` | Rechecks the reviewed unreleased lease through the trusted process-owner provider: `{cleared, detail}`. Missing proof retains quarantine; stale reviews return 409. No caller-supplied evidence/force, filesystem-effect reconciliation or hook replay. Clearance retains ownership and wakes only the Executor |
| `GET settings` | `directoryInventory`, including retired identities; `blocks`: `policy`, `eval` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
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
| `github`, `feishu`, `history` | Source polling, events and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `integration:github`: `{"enabled": false, "repository": "", "cli": ""}`. Operator-only GitHub access; enabling checks identity/push access. Disabling never probes the saved CLI. Intake can remain off while access is ready.
- `source:github`, `source:feishu`: `{"enabled": true, "config": {…}}`. GitHub's config has polling options and the switches `observeIssues`, `observePulls`, `observeComments` and `observeCi`, off by default, which receive every new Issue, new pull request and comment in the repository and the default branch's CI; Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`.
- `policy`: `{"rules": […], "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. An `admission` row is keyed by chat id, `other` or `direct` for Feishu, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: optional operator-only `contextDirectory` (absolute read-only admission baseline) and `gitAuthor` (`{"name":"Local Agent","email":"agent@example.com"}` or null), `model`, `maxWorkers`, `directory` (default-pool root), `prepare` (default hook), `blockedCommands`, `defaultPoolDescription`, `placementInstructions`, and `directoryPools`: `[{"id":"frontend","description":"UI implementation","directories":[{"id":"frontend-1","path":"/srv/frontend-1"}],"prepare":"…","recycle":"…"}]`. `default` is synthesized and cannot appear in `directoryPools`. All IDs are stable; directory IDs are unique across pools. CRUD uses revision-aware whole-block `PUT settings/executor`, not partial patches or filesystem operations. Paths, pool membership and executable hooks can only be changed by panel/API saves, not model settings tools. Semantic description/instruction changes publish new placement context versions; inventory, eligibility and worker-slot changes do not. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing enabled integration credentials runs the corresponding setup check first. Changing repository is refused while old GitHub Triggers, Threads, PR bindings, polling cursors or deliveries remain, including ended/resumable history; use a separate state directory. Disabling the integration preserves saved work and pauses observation; it does not synthesize PR closure or release directories. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.integration.revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/integration:github \
  -d "{\"value\": {\"enabled\": true, \"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup installs the neutral worker environment first as a core requirement. Optional GitHub and Feishu probes are bounded and independent. A failed integration leaves core and the main Session ready, records a specific integration error, and leaves independent work available. Ready GitHub additionally verifies credential routing. Confirmed non-Git directories skip Git subprocesses; markers, ancestor checkouts, unreadable metadata and failed probes remain fail-closed.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the ready agent CLI or fails with an actionable unavailable error; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. When ready it selects the agent CLI as the github.com credential helper; otherwise no GitHub helper is installed. It always rewrites both `git@github.com:` and `ssh://git@github.com/` to HTTPS, preventing fallback to operator SSH credentials, and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. Only an explicit `executor.gitAuthor` supplies local commit identity; git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.

A restart retains directory leases and fences every prior-epoch unreleased directory before dispatch. Replacement Assignments cannot touch it until verified external process-owner evidence and filesystem-effect reconciliation clear recovery; without that support it stays quarantined rather than assuming a recovery note makes execution safe. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

This version targets DSH `0.2.2-rc.3` and Node.js `24.9+`. Before upgrading DSH, also back up its profile's Session store and upgrade every process sharing that store: newly created subagents write catalog version 3, which older DSH versions cannot read. The compatibility update does not change Ticket directories or the application database schema.

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
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
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


## Minimal and local execution paths

For Feishu-only startup, leave `integration:github.enabled` and `source:github.enabled` false. Enable the Feishu plugin, configure its strict-mode bot CLI and allowlisted conversation, and choose the default pool. For an empty directory leave `executor.prepare` empty: the Executor creates the dedicated directory. File results can be delivered to Feishu without a GitHub URL. For no incoming Sources, leave both off and open the main Session to manage settings.

For local Git work, set `executor.gitAuthor` and optionally `executor.contextDirectory` to an explicit baseline. A prepare command using a local clone can be:

```sh
git -C /srv/local-clone worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" HEAD
```

This requires no GitHub account. The local context reader rejects traversal and escaping symlinks, limits regular files to 1 MiB and directory snapshots to 2000 entries, and paginates cached text in bounded pages. It never prepares a Ticket for admission. No context directory means ready GitHub context is used, or context is explicitly unavailable; the authorized message alone may still suffice.

For GitHub work, enable access in Deployment, then use the existing checkout prepare command above against your operator-provisioned local GitHub clone. Enable the GitHub Source separately for notifications, CI and merge/close observation. Without that plugin, ready CLI access remains usable, but automatic intake and PR tracking are unavailable.

Neither prepare path bypasses release safety. A first worker turn may run without a process provider, but after managed execution the lease stays quarantined without trusted owner evidence. An idle Session or successful restart is not quiescence proof. Completed-Ticket reopen execution and restart/host-crash recovery are blocked until a production provider is integrated and verified, even in the default pool.

## GitHub optional settings upgrade

Schema 12 transactionally moves legacy Source `repository`/`cli` into revisioned `integration:github`. Complete credentials enable access even when intake was off. Partial credentials remain disabled drafts with a review notice; fresh installations default access and intake off. Explicit new integration fields take precedence. Old snapshots remain audit history and are normalized on read, without reactivating an account. Legacy writes of account fields to `source:github` are rejected with a pointer to `integration:github`. Disablement and account changes use controlled shutdown/restart and rewrite managed helpers and skills; personal CLI files are preserved. Exact old stock scope/delivery defaults become neutral; custom text and built-in overrides are retained. Downgrading requires restoring a pre-upgrade state backup; an older runtime must not open schema 12.
