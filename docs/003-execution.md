# 003 Execution

This document follows an accepted Ticket through execution, delivery and recovery. It builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first matching row wins.

| Stage | Condition | Panel label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a success, a new Assignment or the Ticket's end clears it | Input undelivered |
| person / answer | It has an Attention | Awaiting answer |
| person / review | The latest Report is `ready` | Awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | Blocked · Failed |
| working / queued | No Assignment, or a pending one | Queued |
| idle | The latest Report is `waiting`, or the Assignment ended | Waiting for a Trigger |
| working | Everything else | Working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or `failed` Ticket to its Executor, so it moves to the next matching stage, usually `working`.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

Each Ticket gets an Executor Session named `worker-<ticket id>`. Acceptance records its short name, assignment text and version-bound pool placement, but no directory until launch reservation. The main Session selects a pool from operator-authored semantic instructions and pool IDs/descriptions; it does not select paths, inspect inventory/eligibility/worker slots or change placement while a Ticket waits. A stale placement context refuses new acceptance atomically; an accepted replay returns the original Ticket and decision even after settings change.

Operator-configured pools supply **fixed inventory** of registered directory IDs/absolute paths. The built-in reserved **`default`** pool always exists and supplies **per-Ticket creation**: a fresh dedicated directory beneath its root, defaulting to `<stateDir>/work`. A short name remains a branch identifier and need not equal a fixed directory basename. No matching operator pool means semantic selection of `default`, not fallback because another selected pool is empty or blocked. Workers cannot choose or change placement.

Executor Sessions run commands without approval as the operator's OS user. Their `dsh-superagent-worker` preset contains the tools needed for work and moves foreground shell commands to background jobs after 5 seconds. This lets a worker receive new messages at the next step instead of waiting for a long command to finish.

The main Session uses `dsh-superagent-router`, with the same 5-second shell and job-wait limits and a smaller tool set for routing. Sessions retain the preset selected at creation. Worker subagents use DeepSeek Harness's `standard` preset.

### Background work and worker slots

When a turn ends with shell jobs or subagents still running, the Ticket keeps its worker slot and stays working. It is not reported as waiting, and the main Session receives no waiting report. A completed job or subagent wakes the Executor with its result in the same slot. Once a turn ends with no background work, the Executor reports waiting normally.

After each turn, background work has at most 30 minutes to finish. At that limit, shell jobs are killed and the Ticket is reported waiting. The report includes the Executor's last words and which jobs were killed or subagents remain active. Subagents are allowed to continue. The Executor reads killed-job results on its next turn.

A handoff to a person frees the slot immediately and leaves the Report in effect. This applies after a `ready` Report or a question, unless another Input arrived since, and after any `blocked` or `failed` Report.

At handoff, subagents stop. Shell jobs, such as a server offered for review, may continue until the Assignment ends. They hold no slot and are exempt from the 30-minute limit, including after later turns. Their completion does not wake the Executor; it reads the results on its next turn.

A person can also start a turn by writing directly in the Executor Session. Its background work follows the same rules.

When an Assignment ends, its shell jobs are killed without waking the Session. Its subagents are released, and any completion turns they wake are dropped. The replacement Assignment and its waiting Inputs start after that shutdown finishes.

Stopping or restarting the plugin inside the DeepSeek Harness process requests the same managed shutdown path. Inputs not yet taken into Session history are retained. Process-local cancellation or an empty job registry does not prove every subprocess descendant stopped. Leases remain held through shutdown; prior-epoch ownership is recovery-fenced on startup and cannot prepare, execute, recycle or release until external process-owner quiescence evidence and interrupted-effect reconciliation establish safety. A recovery note alone is not that evidence.

Worker subagents, including nested ones, use DeepSeek Harness's `standard` preset with the worker's permissions. They retain only the worker's allowed work tools, and lose those tools when the Ticket ends. Under `standard`, a shell command moves to the background after 60 seconds. A subagent's jobs are killed when it ends.

### Reserve, create and prepare

The order is **select a pool → reserve a directory/acquire its lease → create if needed → prepare contents → execute → stop activity → preserve/recycle → release**. Freeing a worker slot, releasing a lease and deleting a directory are different operations.

For first fixed-inventory reservation, the Executor filters eligible candidates and chooses least recently used by last committed lease-acquisition sequence: never-used first, then stable directory-ID tie-breaking. Successful acquisition, including resumption, advances that sequence atomically; failed attempts/releases do not. With affinity, it waits for that exact directory, never substitutes another one or preempts its current owner.

For first `default` reservation, it chooses a nonexistent path based on the short name, disambiguating collisions before committing. Existing paths are not adopted or overwritten. Reservation durably records affinity, lease, prospective Git claim and preparation intent **before** filesystem effects. A crash between reservation and creation retains the same path. An unexpected path appearing after reservation is a remediation conflict, not permission to allocate another path.

The `default` prepare command runs with `sh` in the default-pool root while its reserved target is absent; it must create that exact path non-clobberingly. With an empty hook, the Executor exclusively creates an empty directory. A checkout/worktree must be independent at the claimed path; borrowing an ancestor working tree is rejected, including for an empty directory beneath a repository. Retries/resumption retain the directory and the Ticket's own uncommitted work; they do not apply fixed-inventory clean-for-reuse or external Session presence gates.

Fixed preparation runs inside the registered directory for each new lease, creating the directory first if needed, and restores the requesting Ticket's workspace contents safely. Hooks are operator configuration; model placement text cannot supply commands. Preparation has durable intent/start/completion/failure evidence, so path existence is not proof it finished. Failure retains ownership and output. Interrupted or failed filesystem effects require reconciliation; a retry never blindly replays a creation/preparation hook or changes affinity. A typical default command uses `git worktree` to create its independent checkout. A pull request belongs to the Ticket when its branch's last path segment matches the Ticket's short name.

### Fixed-inventory eligibility and deployment limits

A candidate must have verified canonical identity and filesystem/recycling readiness; no overlapping unreleased directory lease, Git working-tree claim or recovery fence; authoritative external Session clearance; and clean Git state for acquisition/reuse when it belongs to a working tree. Resolve symlinks and directory boundaries, not string prefixes. Git inspection includes the entire resolved working tree, untracked files, staged/unstaged/conflicted and submodule changes, plus unfinished operations; unreadable, malformed or failed probes are unknown, not clean. Never automatically discard, clean, stash or commit pre-existing changes to obtain eligibility. Under the same unreleased lease, the Ticket's own edits are expected and do not make ordinary retries/turns fail a clean-for-reuse gate.

The lease also claims its Git working-tree root and worktree-specific metadata across every pool. `/repo/ui` and `/repo/api` share `/repo` and cannot execute concurrently; distinct linked worktrees may, despite common object storage. Verify identity again before preparation, turn admission and recycling. Unexpected identity changes fence activity rather than silently claiming another owner's tree.

For fixed inventory, an unrelated Session blocks overlapping canonical workspaces or the same Git working-tree resource while running, displayed in any live client Session view, or owning outstanding background activity. Persisted/loaded Sessions, sidebar entries, retained main-view data, focus loss and API reads do not by themselves mean displayed presence. Across tabs/clients, closing one view does not clear others; stopping a turn does not clear a still-displayed view. Unknown startup/reconnect/disconnect observations stay unknown until reconciled. Reservation/use must serialize with conflicting starts/workspace changes/view openings; a one-time poll is insufficient.

**The production authoritative observation/coordinated-admission adapter is not provided yet. Fixed-inventory execution stays `unknown`/unusable without it; configuration/CRUD alone does not enable safe reuse.** This is an operator diagnostic, not a main-Session placement failure, and does not block `default`. One database's directory/Git claims do not cover other profiles/processes/installations: shared fixed workspaces require shared authoritative observation/admission across all of them, otherwise that deployment topology is unsupported. Never kill unrelated work or close user views to obtain a directory.

### Lease lifetime and safe release

A lease belongs to a Ticket, not its Assignment or worker slot. It remains held through waiting, review, blocked/failed work, retries and runtime shutdown. Every unreleased state (`reserved`, `preparing`, `active`, `releasing`) excludes other owners. An active lease proves preparation finished, not worker execution or recovery clearance.

Ending queues asynchronous stopping, required preservation/recycling and atomic directory/Git-claim release. Fixed recycle hooks preserve required state and must leave reusable Git workspaces clean; missing hooks or failed/unknown checks do not justify discarding artifacts or freeing ownership. `default` preserves dedicated contents without reuse gates. Lease release is not deletion. Affinity survives release: an ended Ticket resumes only in its original directory after normal authorization checks and safe reacquisition/restoration. Retiring a registration retains its identity/history; an unavailable original directory requires operator remediation rather than substitution.

### Concurrency

A Ticket holds a worker slot from the start of a launch, including preparation, or from the delivery that wakes its idle Executor. It also holds the slot throughout an active turn.

The configured concurrency limit applies to these slots, with one extra slot for a person's message or a status request. Such a wake can use the extra slot when normal slots are full, and takes the next free slot before a new launch. New work therefore cannot prevent a person from continuing an existing Ticket.

Other Inputs, such as CI results, wait for a normal slot. A launch waits in `working / queued` until a worker slot and its policy-specific directory admission are available. No worker slot is held merely while waiting for directory eligibility, exact affinity, a Git resource or a recovery fence; a committed lease may remain held without a worker slot. Launches run concurrently, so a slow prepare command delays only its own Ticket. Neither directory availability nor the worker limit triggers pool reselection.

### Execution variables

The prepare command and Executor instructions receive the same execution variables. The command reads environment variables; the Executor reads their values and descriptions in its prompt. None contains credentials.

| Variable | Registered by | Value |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET` | Executor | The Ticket's directory, short name and id |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | Commands the Executor may not run |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | The ready integration repository, `owner/name`, independent of intake |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`, `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | The agent account and its commit email |
| `DSH_SUPERAGENT_GITHUB_NUMBER`, `DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | The Issue or pull request that started the Ticket, and its head ref when it is a pull request |
| `DSH_SUPERAGENT_FEISHU_BOT`, `DSH_SUPERAGENT_FEISHU_CHAT` | Feishu | The bot, and the chat that started the Ticket |

Ticket-specific values come from its directory and originating Trigger. Other values come from the current deployment settings. Only the panel can change execution environment settings; text sent to the main Session cannot change the configured shell command.

When GitHub is ready, workers reach it through the agent account's `gh` and Feishu through the bot's `lark-cli`. Blocked commands fail when invoked by name.

These wrappers and directories establish defaults, not a security boundary. A worker can still execute a program by absolute path.

## Merging

Auto-merge is governed by the **Delivery requirements** prompt. The host has no merge-specific decision logic.

By default, the Executor never enables auto-merge as the agent account: GitHub attributes the merge to whoever enabled it. Delivery requirements must name another account's CLI for merging. Without one, people merge the pull request.

The default instructions allow auto-merge only for a pull request opened for the Ticket, when it is ready, the required approvals cover the head commit, and additions plus deletions total fewer than 200 lines. Before pushing another revision, the Executor withdraws auto-merge.

Reviews without a body, such as approvals, also arrive as Triggers and can wake an Executor waiting for review. These instructions govern the agent, not GitHub's merge rules. To enforce approvals, require them in branch protection and dismiss stale approvals. Omit the merge CLI or remove the auto-merge paragraph to require manual merging.

## How a Ticket ends

- **Ready without a pull request:** a `ready` Report ends the Ticket as completed.
- **Nothing to do:** an Executor that finds no work for a person to act on, such as a request that does not reproduce or is superseded, reports `dropped`. The Ticket ends without a message, unless a matched rule asks for one, and a person's later message on its Threads resumes it.
### Pull requests

A Ticket follows the pull request it started from once its Executor reports it. It also follows each pull request opened from its branch once reported by the Executor or found by the GitHub Source. Reopened pull requests are followed again.

The Ticket is done when none of the pull requests it opened remain open. If it opened none, all pull requests it follows must be closed. It then ends with the outcome of the last relevant close and keeps its Subscriptions, allowing a later human comment to resume it.

A close does not end the Ticket while resumed, retried or recovered work is unfinished. It also waits if the Executor acknowledged or answered a follow-up it owns but has not since made a non-progress Report or ended a turn after reading that message. A later `ready` Report ends the Ticket once the same pull-request completion rule is satisfied.

Chat Channels receive one final notice about the pull-request outcome. GitHub already displays the outcome on the pull request itself. Removing a Ticket's Subscription to a pull request also stops it following that pull request.

"Awaiting review" therefore means a `ready` Report with a pull request.

### Follow-ups and context Threads

The Executor decides human follow-ups on its Ticket's own Threads. It handles in-scope requests and hands back requests beyond its scope or for another Ticket. Once no Executor owns the message, it becomes a candidate for the main Session. The main Session may otherwise act on the follow-up only to stop work at the person's request.

An Input counts as read after the Session takes it into a step and subsequently reports or ends a turn. When a Ticket ends, unread messages that were not acknowledged, answered or handed back return to Eval, as described in [002 Authorization](002-authorization.md). Read messages left without action, such as thanks, do not.

Threads followed only for context still deliver messages, but do not give the Ticket ownership of human follow-ups or resume ended Tickets. Those messages can be assessed independently.

Sources poll subscribed Threads while a live Ticket subscribes, and for two weeks after the later of the last Trigger and the subscribing Tickets' end. Afterwards, messages arrive only through ordinary intake: GitHub notifications or Feishu live events.

## Failure and recovery

### Executor blocked or failed

When an Executor Session reports `blocked` or `failed`, or fails to start or errors, which records `failed`, the Ticket takes no automatic Input.

A passing failure of the model provider or the network, an HTTP 408, 429 or 5xx or a refused, reset or timed-out connection, is tried again first, three times with a growing backoff: a launch runs again, and a worker whose turn failed is told to go on; a failed prepare command is not tried again.

Once failed, CI and bot messages are recorded on it, but they are not delivered and do not wake the Session.

Its tools stay available, so a person can continue in the Session directly.

A launch that failed is not tried again on its own.

A person's message, a later Report that is neither `blocked` nor `failed`, or a retry ends the hold.

It is worked out from the stored Reports and Inputs, so a restart keeps it.
### Retry

Available while an open Ticket is in `person / delivery`, `person / blocked` or `person / failed`: a new Assignment, which starts its worker again and takes the Inputs that wait, is the remedy for each.

Once a person's message reached a blocked or failed Ticket, the Executor has the message, so the Ticket shows as working, or as queued when a failed launch starts again, and offers no retry, unless delivering that message failed.

A retry ends the current Assignment and starts a new one in the same Executor Session, directory, branch and pull request.

The Executor model applies only when a Session is created; an existing Session keeps its model.
### Restart

Before restoring managed Sessions or dispatching filesystem effects/worker turns, startup fences every prior-epoch unreleased lease, including `active` ones. It retains the accepted pool, affinity, queue, preparation evidence and exclusive Git resource. Lease lifecycle state alone does not clear recovery. Quarantined directories hold ownership but no worker slot; old-epoch callbacks cannot release or mutate later ownership.

Recovery requires an external supervisor/OS process owner containing all managed descendants (including prepare/recycle hooks), or an equivalent supported durable owner, to prove the old execution range empty. It must also reconcile interrupted filesystem effects before use. Host exit, lost handles, elapsed time or an empty DSH process-local job registry are not proof. **No production process-owner evidence adapter is currently installed by this bundle, so affected leases stay quarantined rather than automatically restarting safely.** An operator must establish verified cleanup through that trusted mechanism; an acknowledgement or registration edit is not evidence.

After recovery clearance, interrupted running Assignments may be replaced with recovery notes reminding the Executor to check its directory, Git history and GitHub before repeating outside actions. Waiting, ready, blocked or failed Assignments otherwise retain their Reports unless later Inputs require continuation. These notes preserve work context; they never replace ownership/quiescence checks.

Sessions, directories, Subscriptions, pending messages and the stored work below survive a restart, and so does the record of which messages each Executor Session took into its history, which a step does once it claimed them and before its model call: a message taken by a turn the restart cut off counts as read once a Report or the end of a turn follows, while one a step claimed but a cancel or error cut off before the history counts as unread.

A retry or a restart gives the new Assignment again the messages delivered to the Assignment it replaces that its Executor Session did not take, which a cancel or a cut-off step may have dropped; a copy still waiting in the Session, kept by a restart or persisted across a crash, is taken out before the new Assignment's first message, so the new delivery is the only copy.
### Stored work

What dsh-superagent does after a decision, such as relaying a candidate, a follow-up or a report to the main Session, launching an Assignment or delivering an Input, is stored first and done afterwards.

A relay or a delivery that fails, such as when its Session cannot be reached, is retried after 2 seconds, then after a delay that doubles up to a minute; a launch that fails fails its Ticket, unless the failure was a passing one, as above.

Each kind of work reports an error among the overview's system problems only after one item failed three times in a row; a failed Input delivery shows on its Ticket instead.

Relays to the main Session keep their order, and so do notices; a failed one holds back the later ones of its kind.
### Source failure

The GitHub Source reads each Issue, pull request and Thread on its own: a failed read keeps its error on its Thread, is read again on the next poll, and counts towards an error of the Source, which it reports after three failed polls in a row by default; any successful poll resets the count.

GitHub answers 404 also when the agent lost access to a private repository, so a 404 is retried.

A notified Issue or pull request whose reads keep failing is dropped a day after its first failed read, and at once when GitHub reports it as deleted; it then no longer fails the poll, its Thread keeps the error, and the Source's state names it.

Its read position stays where it was, so a later notification or a poll of its Thread reads what the failed reads missed.

The Feishu event consumer reports every failure, and polling of subscribed topics keeps each failure on its Thread.

A malformed item in a GitHub list or a Feishu page is skipped, and the Source's state counts it.
### Channel failure

Outgoing messages are stored and sent as stored work, retried with backoff from 5 seconds, doubling up to 300.

A Ticket's messages to one conversation go out in the order they were queued, so its acknowledgement comes before its later answer or result: a message waits while an earlier one of the same Ticket to the same conversation has not gone out, until that one has failed three times in a row and shows as a problem.

Messages of other Tickets, and messages of no Ticket, do not wait for it.

A message with failed attempts is a system problem until it goes out or is withdrawn.

A message is dropped only when its Source no longer listens to the conversation, or when the Source answers that the conversation can never receive it; while its Source is off, it waits.

The Sources answer that for a deleted Issue or a locked conversation on GitHub, and for a recalled message or one Feishu no longer finds on Feishu.

A reply to a review comment that no longer exists goes to the pull request's conversation instead.

A dropped message keeps its record, with when and why it was dropped and the Ticket it was for, so it is never queued again; a dropped acknowledgement reads as dropped, not sent.
### Pause processing

Stops dispatch, new Evals, Eval timeouts, Input delivery and replies; a launch already under way waits until processing resumes.

Sources keep recording Triggers, and a running Executor turn is not interrupted.

A person's message to an ended Ticket waits: the first pass after the pause resumes the Ticket, if its Mandate holds under the Policy then.

An Eval in progress does not expire during a pause; its deadline moves later by the pause's length.
### Invalid configuration

A stored Source configuration that its kind rejects disables that Source instance.

GitHub access and automated Source monitoring are independent. Identity variables are available with ready access even when intake is off or the Source plugin is absent; unavailable identity variables are cleared from subprocess environments. Automatic PR discovery, CI and merge/close observation require the installed enabled Source. Disabling access preserves bindings, subscriptions and leases and pauses observation. A ready local Ticket without lifecycle-bound Threads completes without a PR.

`executor.contextDirectory` is a separate read-only admission baseline, never the operator cwd or a prepared Ticket directory. `executor.gitAuthor` explicitly configures local author name/email. Without it or a ready suggested GitHub identity, a requested commit needs an author; file-only work still proceeds. Confirmed ordinary directories require no Git subprocess for verification; markers, ancestor checkouts, bare repositories and unknown inspection results remain fail-closed.
