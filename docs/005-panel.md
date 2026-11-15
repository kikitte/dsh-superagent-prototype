# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

**Open main Session** is disabled while deployment setup is incomplete; its tooltip identifies the missing requirement, also shown in Overview. The main Session is created after setup succeeds. A saved Session ID alone does not mean that Session has been created, archived or deleted.

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Source**, **Trigger**, **Eval**, **Execution**, and **Settings**. Until repository and account setup succeeds, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | Tickets needing action, system problems, activity counts for the last 24 hours, and Executor load. Each block links to its detailed page |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Overview |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, authorization, waiting Inputs, Subscriptions and Assignments |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced.
- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** worker model and worker-slot limit, execution directory pools, dedicated pool-selection instructions, default-pool root/preparation, and blocked commands. Clicking an available variable inserts it into the default prepare command. The reserved `default` pool is always present: its description is editable, but its per-Ticket allocation policy and identity cannot be removed or shadowed. Operator-created pools use fixed inventory, including empty inventories.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

### Directory pool operations and diagnostics

Use **Add pool**, **Edit pool**, and **Register directory** to edit a draft with stable pool/directory IDs, semantic descriptions, absolute registration paths and preparation/recycling hooks. A directory's **Pool membership** selector moves an unused registration between fixed pools in the same draft; retained history or leases prevent moving it. Diagnostics can be filtered by pool. **Remove pool** and **Remove registration** ask for confirmation. The Execution block's **Save** commits the entire block against its revision; **Discard changes** cancels the draft. Registration never creates, moves, cleans or deletes filesystem contents. The backend rechecks canonical aliases, boundary overlaps, historical identities, queued selections, leases and recovery fences atomically with saving; a conflict keeps the draft for review.

The main Session sees only pool IDs/descriptions, pool-selection instructions and the semantic context version. It selects a pool based on Ticket requirements, not directory inventory, eligibility or worker slots. If no operator pool matches, select `default`; an empty or blocked selected pool waits without switching pools. Preparation/recycling hooks are executable operator configuration, separate from those semantic instructions and authorization rules.

**Directory diagnostics** and **Refresh directory eligibility** are read-only operator views. They report canonical directory records (including retired identities), current lease owner/state, preparation, recovery fencing, Git probe evidence and external Session occupancy separately from the worker-slot limit. No current lease does not mean a directory is eligible. Unknown observation/admission capability is a safety diagnostic, never invented readiness. In the current deployment, fixed inventory remains unusable without an authoritative cross-Session observation/admission adapter; default-pool work does not depend on that adapter.

For a recovery-fenced lease, diagnostics show its execution epoch, recorded durable process owner, preparation/recycling state and any verified quiescence evidence. **Recheck recovery evidence** asks the installed trusted process-owner provider to verify the entire recorded execution range is empty. Missing provider, missing owner or unavailable proof retains quarantine with an explanation. The request is bound to the displayed lease and epoch; changed state refuses the review and requires refreshed diagnostics. Operator acknowledgement cannot substitute for proof. Successful verification retains directory ownership and affinity and wakes only the Executor to recheck admission. Ordinary preparation or safe release may then continue; failed/interrupted filesystem effects retain their reconciliation diagnostics and hooks are not replayed. Filesystem-effect reconciliation remains a separate, unimplemented operator workflow.

A lease belongs to its Ticket across waiting, retries and restarts. Ending begins stopping, preservation/recycling and safe release; it does not immediately free a directory or delete its contents. A Ticket's affinity retains its original pool, directory ID and canonical path even after release, so resumption waits for that exact directory. Retained IDs cannot be repointed or recycled for another registration. Pools with open selections or unreleased leases, and directories with unreleased leases/recovery fences, cannot be removed. Changing a leased pool's executable hooks is refused until its leases are safely released.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
