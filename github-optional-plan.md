# Plan to make GitHub optional

Status: implementation is in the working tree. Automated checks and real local/no-Git DSH runs pass; full runtime completion remains open for production process-owner integration and authorized live Feishu/GitHub checks. See [verification evidence](docs/github-optional-verification.md).

Superagent must start, open its main Session, evaluate authorized requests, execute Tickets, and deliver results without a GitHub account, repository, CLI, or Source plugin. GitHub becomes an optional integration for repository access, GitHub delivery, and PR tracking. Feishu can operate independently. An installation with no active Sources can start and remain idle.

The execution target is the Ticket's leased execution directory. Its contents may be ordinary files, a local Git repository, or a GitHub checkout, according to the selected pool and its prepare command. Enabling GitHub does not clone a repository or choose the Ticket's directory.

## Required behavior

| Configuration | Core and main Session | Execution and delivery |
| --- | --- | --- |
| GitHub absent or off; Feishu ready | Ready | Feishu requests, ordinary directories, local Git work, and results returned to Feishu |
| Both integrations absent | Ready and idle | Management and main Session available; no incoming Source is required for readiness |
| GitHub ready; GitHub intake off | Ready | GitHub access and delivery available to Tickets from Feishu; no GitHub polling or automatic PR tracking |
| GitHub ready; GitHub intake on | Ready | Existing GitHub notifications, PR association, CI, merge/close observation, and delivery |
| GitHub requested but invalid or inaccessible; Feishu ready | Ready with a GitHub error | Feishu and independent work continue; GitHub operations return a specific unavailable error |
| Feishu invalid; GitHub ready | Ready with a Feishu error | GitHub work continues; existing bot-only authentication restrictions remain |

GitHub intake requires both a ready GitHub integration and the installed, enabled GitHub Source. A configured integration does not itself enable intake. Without the Source plugin, GitHub CLI access can still be available, but automated Source behavior and PR tracking are unavailable and must be described that way.

## Current dependencies to remove

| Area | Current coupling | Planned change |
| --- | --- | --- |
| Deployment | `src/deployment.ts` requires `repository`, resolves a GitHub user, and checks push access | Keep machine readiness independent; resolve GitHub only when explicitly enabled |
| Startup | `src/app/setup.ts` always calls the GitHub resolver; `src/app/runtime.ts` returns before installing Sessions and execution when it fails | Distinguish core failure from optional integration failure |
| Worker environment | `src/infra/environment.ts` always writes a GitHub CLI shim and credential helper, and verifies GitHub Git configuration | Always write the neutral environment; add GitHub credentials and checks conditionally |
| Directory verification | `src/infra/environment.ts` runs `git config` for every prepared directory, including non-Git directories | Skip Git-specific verification only for positively identified non-Git directories; preserve fail-closed Git inspection |
| Directory release and recovery | Default and fixed-inventory leases require durable process-owner evidence after managed execution; the bundle ships no production provider | Integrate and verify a production provider before claiming completed-Ticket reopen or restart recovery |
| Commands | `src/infra/commands.ts` dereferences `deployment.github` and a top-level repository | Require a ready GitHub capability only at GitHub call sites |
| Admission | `src/app/assessment.ts` implements file/directory reads through `sources/github-read.ts`, including for Feishu candidates | Expose available context explicitly; support a bounded local context directory |
| Worker reports | `src/app/tools/executor.ts` reads the GitHub login while constructing every report tool | Build the ordinary report tool without GitHub; guard PR-specific arguments and actions |
| Runtime events | `src/app/runtime.ts` constructs a GitHub context and formats PR end notices using the deployment repository | Invoke GitHub behavior only when its integration and relevant adapter are available |
| Resources and links | `src/app/resources.ts`, `src/app/cards.ts`, and Source link types assume GitHub resources or repository context | Preserve local history; gate live reads and use optional link metadata |
| Prompts and skills | `src/app/prompts.ts` always adds the GitHub skill; bundled prompts assume repository work, GitHub commit identity, and PR completion | Compose instructions from available capabilities and the assigned deliverable |
| Environment variables | `src/app/execution-environment.ts` obtains GitHub variables from enabled Source declarations | Export integration identity independently of intake; clear variables when unavailable |
| Settings and panel | Repository/account fields live on GitHub Source; setup account views dereference a GitHub login | Separate integration configuration, core readiness, and Source health |
| Deployment guidance | `SETUP.md`, `README.md`, package description, and deployment docs require GitHub | Document a minimal deployment and optional GitHub setup |

## Configuration and readiness

### Separate GitHub access from GitHub intake

Add a revisioned `integration:github` settings block, stored as `settings.integrations.github`:

```json
{
  "enabled": false,
  "repository": "",
  "cli": ""
}
```

Keep `source:github` for `enabled`, polling, observation switches, and intake behavior. Repository and account CLI move to the integration block. Keep Feishu's existing bot configuration in its Source block for this change; making GitHub optional does not require redesigning every Source.

- New installations default to GitHub integration off and GitHub intake off. Loading the bundled plugin alone does not activate either.
- An enabled integration requires both repository and CLI and retains the existing identity and push-access checks. Empty fields are valid while off; partially configured enabled integrations are invalid.
- Saving `enabled: false` must not run GitHub probes. An expired login, missing executable, or unreachable repository must never prevent disabling it.
- Keep integration account changes operator-only, following the current panel/API origin guards. Main Session settings tools cannot enable GitHub, change accounts, or change its repository.
- Preserve optimistic concurrency, recheck revisions after asynchronous preflight, and audit the new settings block. Update HTTP block parsing, settings resources, notifications, and revision storage together.
- Turning intake off leaves ready GitHub execution credentials available. Turning the integration off removes GitHub capability and pauses intake without deleting its saved configuration.

### Separate base deployment from resolved capabilities

Reshape the resolved deployment so GitHub is optional and its repository travels with its account:

```ts
interface GitHubDeployment {
  repository: string
  cli: string
  login: string
  noreply: string
}

interface Deployment extends Machine {
  github?: GitHubDeployment
  feishu?: FeishuBot
}
```

Use separate integration status values such as `off`, `checking`, `ready`, and `error`, with a structured problem on error. A missing capability is represented by absence, never a dummy repository, synthetic account, or empty account object. A small `requireGitHub()` guard returns a specific integration-unavailable error before any subprocess is invoked.

Core setup errors remain fatal to core readiness: state-directory ownership, database/lock problems, invalid managed environment files, and failure to install the base worker environment. GitHub and Feishu authentication errors belong to their integrations and Source health. Bound optional probes and run independent checks concurrently so one account does not prevent the other from being checked.

The main Session and core loops start once base setup is complete, even if an optional integration check failed. The panel receives explicit core readiness and main Session availability; the Open main Session button follows actual Session creation rather than the presence of a generated ID or a GitHub status.

## Worker environment without GitHub

- Always retain isolated Git configuration, removal of ambient Git-location variables and GitHub tokens, disabled interactive credential prompts, blocked-command handling, managed-file ownership checks, and the bot-only Feishu wrapper.
- When GitHub is off or unavailable, the managed `gh` shim returns an actionable unavailable error. It must not fall through to the operator's `gh` or inherit their login.
- Always retain GitHub SSH-to-HTTPS rewrites for both `git@github.com:` and `ssh://git@github.com/`, including when GitHub is off or unavailable. Removing them would let ordinary Git commands against existing SSH remotes select the operator's SSH agent or private keys without invoking the managed `gh` shim. Install GitHub credential helpers only for a ready integration; rewrite the entire managed configuration so disabling removes stale helpers while retaining the rewrites.
- Keep local Git usable independently. A neutral worker Git configuration may clear inherited credential helpers and require explicit commit identity without installing GitHub-specific credentials.
- Add optional operator-configured `executor.gitAuthor` name/email for local commits, protected by the execution-environment origin guard. Without it, ready GitHub supplies the existing suggested identity; without either identity, do not invent one. A task needing a commit reports the missing author; file-only work still proceeds.
- Verify base environment properties separately from GitHub credential routing. Do not execute a GitHub helper check when GitHub is off.
- Superagent startup and plain-file Ticket execution in ordinary directories must not require `gh`, GitHub access, or a successful `git` invocation. Git is required when the selected operation or directory actually uses Git; keep DSH's own prerequisites distinct from Superagent's checks.
- Refactor `verifyDirectory()` and its Executor callers so Git-specific credential/configuration checks run only when directory inspection establishes a Git working tree. Use the existing canonical directory and ancestor-marker inspection to positively establish non-Git directories without invoking Git; preserve checks for ancestor checkouts, linked worktrees, and bare repositories. Missing Git, unreadable metadata, or a failed Git probe must never be reclassified as non-Git. Recheck directory identity at the existing preparation and execution boundaries so a directory that becomes a repository cannot retain a non-Git exemption.
- Preserve local Git metadata, working-tree claims, and fixed-inventory cleanliness checks regardless of GitHub state. A failed Git inspection remains unknown and ineligible where the directory protocol requires verification.
- Keep generic Ticket variables available. Publish GitHub repository/account/email variables whenever the integration is ready, even when intake is off. Populate Issue/PR variables only for the relevant verified context. Explicitly remove stale GitHub variables from subprocess environments when unavailable; omitting prompt lines alone is insufficient.
- Run prepare/recycle commands with the same capability-aware environment. Existing hooks using GitHub continue to require the integration; do not parse shell text to infer dependencies, silently replace hooks, or change pools on failure.

These wrappers retain the existing credential-selection behavior. They do not introduce an OS sandbox or support credentials for other remote hosts. Local Git works without GitHub; provisioning authenticated access to other Git services is separate work.

### Directory release and recovery prerequisite

The unfinished process-owner integration in `ticket-directory-leasing-plan.md` affects both default per-Ticket directories and fixed inventory. After managed execution, `DirectoryManager.release()` quarantines a lease without trusted process-owner evidence; the same Ticket cannot execute an authorized follow-up while that lease is releasing or quarantined. Default allocation bypasses fixed-inventory occupancy checks, not process-quiescence requirements. The current bundle ships no production `executionDirectorySafety.processes` provider, so a successful first worker turn alone does not establish working reopen or restart recovery.

Integrate a production durable process-owner provider through the existing `DirectorySafety` contract before claiming these lifecycle scenarios pass. Persist its owner identity before the first managed effect, contain prepare/recycle hooks and all worker descendants, and verify the entire execution range is empty before release or recovery. The provider must work across controlled restarts and host crashes; a missing process-local handle, an idle Session, or a successful restart is not proof. This uses the existing leasing contract without changing affinity, allocation, or recovery rules. Fixed-inventory execution additionally requires the separate authoritative occupancy/admission integration.

Core startup, management, and the main Session remain available without these providers. Surface the missing provider and retained ownership in execution diagnostics and setup guidance; preserve quarantine when evidence is absent. If the production provider is unavailable, record completed-Ticket execution after reopen and restart recovery as blocked prerequisites and leave the corresponding completion checks unchecked. Do not substitute deterministic test-provider evidence for production integration evidence or weaken the lease protocol to make the scenarios pass.

## Tools, context, and Ticket lifecycle

### Ordinary reports and delivery

Construct `orchestrator_report` without obtaining any GitHub context. Preserve the existing progress, ready, blocked, failed, dropped, questions, and answer behavior. Keep `pr_number` optional for compatibility; accepting a non-null value requires ready GitHub access and the installed GitHub adapter before any report or PR-binding state changes. A rejected PR claim must leave the report transaction unchanged.

Retain the existing generic completion rule: a ready Ticket without lifecycle-bound Threads completes without a PR. A GitHub-bound Ticket continues to follow its existing close/merge rules. Result delivery to Feishu must work for local files, local commits, and other explicitly requested deliverables without a GitHub URL.

### Resource reads and admission

- Keep stored Tickets, Triggers, reports, transcripts, and Thread history readable when GitHub is off. Saved URLs may still render as links without making an API call.
- Advertise live `github/…` resources only when available. Explicit attempts to read them when unavailable return a structured capability error before calling `gh`.
- Add an optional, operator-only `executor.contextDirectory` for read-only admission context. It is an explicit local baseline, independent of Ticket directory allocation and the process current directory.
- For admission file/directory requests, use the configured local context directory first; otherwise use the existing GitHub reader when GitHub is ready; otherwise report that repository context is unavailable. Expose this choice in the Eval context so the main Session can assess from the authorized message when sufficient.
- Local reads must enforce canonical root containment, reject traversal and escaping symlinks, preserve bounded pagination, and bound file sizes and read duration. Never create a Ticket directory or run a prepare command to obtain admission context. Do not substitute the operator's current directory or home directory.
- Missing repository context is not itself a global setup error or automatic rejection of every request. If the specific assessment needs unavailable context, record that assessment as unavailable with its concrete reason.

### GitHub observation and existing work

Guard notifications, subscribed-Thread polling, CI reads, PR discovery/claiming, and merge/close notices on the ready integration. Source polling additionally requires the installed, enabled GitHub Source. No Source or maintenance path may dereference GitHub merely because the core deployment is ready.

Disabling GitHub must not delete saved Threads, cursors, PR bindings, Tickets, directory affinity, or leases; synthesize a PR closure; or convert an existing PR-bound Ticket into completed local work. GitHub-dependent live reads and delivery become unavailable, pending work stays visible, and Feishu work that does not depend on GitHub continues. Preserve the current rule that intake off also stops its PR observation; show that monitoring is paused.

Keep repository/account changes and capability disablement on the existing controlled restart path: stop polling, cancel or drain in-flight integration calls, perform normal worker shutdown, replace the environment, and resume under the new configuration. Do not treat a capability change as evidence that worker processes stopped or directory recovery is safe. Late results from the old runtime must not publish credentials, bind a PR, or send a message in the new configuration.

Before changing a configured repository to a different one, reject the save while retained GitHub Triggers, Threads, PR bindings, polling cursors, or pending deliveries belong to the old repository. Include ended Tickets and their resumable subscriptions in this check. The error must identify the retained state and recommend a separate state directory for a different repository. Disabling remains possible, and re-enabling the same repository resumes normal reconciliation. This keeps the existing single-repository identity model; repository switching with retained history would require a separate design for repository-qualified keys. Do not interpret old numeric PR references against a different repository.

## Prompts and skills

Change the default role and work instructions to address the authorized task in its execution directory. Make GitHub-specific behavior conditional on available capabilities and the assigned deliverable.

- Register the GitHub skill only when GitHub access is ready. Keep the existing conditional Feishu skill behavior and team-defined skills.
- Remove unconditional statements that every task targets the deployment repository, every code change requires a PR, or every commit must use GitHub account/email variables.
- Put PR author checks, GitHub reviewer credit, CI handling, merge rules, and GitHub-specific handoff instructions in a conditional GitHub section/skill. Preserve them for GitHub work.
- Keep source acknowledgements, scope limits, implementation checks, truthful reports, and real Before/After evidence for UI changes applicable to local delivery too.
- Describe available capabilities and admission context in generated environment instructions. Recompose prompts and refresh managed skill files after capability changes; stale GitHub skills must not remain installed for resumed Sessions.
- Preserve operator-edited scope/delivery text and built-in overrides. Convert only unchanged stock defaults to the new neutral defaults; show custom GitHub-dependent text for operator review rather than silently rewriting it. Runtime capability guards remain authoritative if custom instructions request unavailable GitHub operations.

## Panel and deployment

Place optional GitHub repository/account configuration under Settings → Deployment, with its own enable switch, connection status, and retry action. Link the GitHub Source card to that configuration; keep its switch clearly labelled as request intake. Core readiness, integration health, and Source monitoring health must be distinct in Overview and the management API.

Update account summaries, search empty states, resource lists, setup messages, and both interface languages to handle an absent GitHub account. No `@undefined`, blank repository requirement, or GitHub onboarding prompt should appear in a GitHub-free installation. GitHub intake enabled without ready credentials should show its own actionable error.

Revise `SETUP.md`, `README.md`, `package.json` description, `docs/000-philosophy.md` where relevant, and `docs/001-domain.md` through `docs/008-cookbook.md` wherever behavior changes. Update `examples/`, the bundled Source defaults, status output, and HTTP examples as needed.

Document prerequisites by capability:

| Deployment capability | Additional requirements |
| --- | --- |
| Base Superagent | Supported DSH/Node environment, configured model, writable state directory; operational scripts retain their own shell/Python/tmux requirements |
| Feishu | Dedicated bot CLI configuration in strict mode bot and app permissions |
| Completed-Ticket execution after reopen and execution-directory restart recovery | Production durable process-owner provider covering both default and fixed-inventory leases, with verified quiescence evidence |
| Fixed-inventory execution | Authoritative cross-runtime Session/view occupancy and coordinated admission integration, in addition to process-owner support |
| Local Git execution | Git and an explicitly configured commit author when commits are requested |
| GitHub | Supported `gh`, dedicated agent account, repository push access, and GitHub-specific Git requirements; LFS only for repositories using it |

The setup guide must offer Feishu-only and GitHub-enabled paths without asking a Feishu-only operator to create a GitHub account. Include working examples for an empty per-Ticket directory, a local Git worktree prepared from a local clone, and the existing GitHub workflow. A zero-Source deployment starts idle and explains how to enable a Source.

## Existing settings and compatibility

Implement a small, idempotent settings migration for this change; do not broaden it into migration of the older directory-leasing design.

1. When no new integration block exists, move existing GitHub `repository` and `cli` into it. Complete existing credentials imply integration enabled even if GitHub intake was off, preserving Feishu-to-GitHub execution setups. Empty defaults imply integration off. Preserve partial values as disabled drafts with an explanatory notice.
2. Preserve GitHub Source intake/observation settings, policy allowlists, bot rules, cursors, and all Ticket state. Fresh installations default intake off; existing explicit intake choices remain intact.
3. Keep old settings versions as audit history. Normalize legacy payloads when reading historical settings rather than silently stripping repository/CLI fields through the new Source schema. A historical version cannot reactivate credentials on its own.
4. Apply the migration transactionally and advance appropriate revisions so an old panel draft cannot overwrite the migrated configuration. New integration fields take precedence when both representations are present.
5. Replace managed shims/configuration through existing atomic writes and ownership checks. Preserve personal CLI configurations. Retain custom prompt text; update untouched stock prompt sections through the existing built-in/default-change mechanism.
6. Reject legacy writes that still place repository/CLI in `source:github` with a precise pointer to `integration:github`; update clients, deployment examples, and docs in the same release.
7. Document that downgrading requires restoring the pre-upgrade state backup; avoid allowing an old runtime to silently read the new settings schema.

## Implementation sequence

Each phase needs its listed verification before proceeding. Runtime behavior is complete only after the final live checks.

### Phase 1 Settings and capability contract

- [x] Add the integration schema/block, optional deployment type, integration statuses, operator guards, revision handling, and settings migration.
- [x] Move GitHub repository/account ownership out of its Source schema and form.
- [x] Add explicit GitHub guards and update all deployment consumers to compile without a mandatory repository/account.
- [x] Verify fresh defaults, current configured deployments with intake on/off, partial drafts, repeated migration, panel-only account changes, and concurrent saves.

### Phase 2 Startup and execution environment

- [x] Split base setup and optional account resolution; isolate errors and bound independent checks.
- [x] Write and verify a neutral environment; add/remove GitHub credentials conditionally, retain GitHub SSH-to-HTTPS rewrites in every capability state, and preserve local Git behavior.
- [x] Refactor per-directory verification to avoid `git config` for positively identified non-Git directories, while preserving Git identity and credential checks for actual repositories and unknown states.
- [x] Add optional local commit identity and clear stale integration variables.
- [x] Start the main Session and core loops without GitHub; expose actual main Session availability.
- [x] Verify absent `gh`, absent GitHub credentials, failed GitHub probes, disabling with an invalid old CLI, and removal of old managed helper configuration. With GitHub off, test both SSH remote URL forms using an isolated HOME and stub SSH/helper programs; neither SSH nor the previous agent helper may be invoked.
- [x] Execute and deliver a plain-file Ticket with both `git` and `gh` absent from Superagent's verification and worker PATH; test that Git markers, unreadable metadata, and failed Git probes still fail closed rather than obtaining the non-Git exemption.

### Phase 3 Tools and Source behavior

- [x] Remove eager GitHub context construction from report tools and generic runtime behavior.
- [x] Gate live resources, PR claims, observation, policy/source helpers, links, and notifications.
- [x] Implement bounded local admission context and advertise available reads.
- [x] Preserve no-PR completion, Feishu reply delivery, paused GitHub work, repository-change restrictions, and controlled restarts.
- [ ] Integrate and validate the production durable process-owner provider required for completed-Ticket reopen and restart recovery in both allocation policies. Verify hooks and descendants are covered; record a blocked prerequisite if the provider is unavailable, without claiming this phase's lifecycle verification is complete.
- [ ] Verify default-directory release, authorized execution after reopen in the same directory, and restart recovery with production evidence; separately verify missing provider/owner/proof retains quarantine and produces actionable diagnostics without blocking core readiness.
- [x] Verify report atomicity on unavailable GitHub, no unintended GitHub subprocesses, and restart/cancellation races.

### Phase 4 Prompts and panel

- [x] Compose neutral defaults plus conditional GitHub behavior and skills; preserve custom text.
- [x] Add optional integration settings and localized status views; remove mandatory GitHub onboarding assumptions.
- [x] Verify Feishu-only tool descriptions, resource grammar, prompt previews, skill cleanup on resumed Sessions, and main Session navigation.

### Phase 5 Deployment and full verification

- [x] Update installation/setup paths, examples, package metadata, operational status, and affected documentation.
- [ ] Document process-owner prerequisites for default-directory reopen/recovery as well as fixed inventory, and identify the installed production provider and its evidence before running the dependent live scenarios.
- [x] Run targeted tests during each phase, then `pnpm check` and `git diff --check` for the completed change.
- [ ] Perform the real DSH and browser scenarios below and record actual evidence with model/network/mock boundaries identified.
- [x] Review the final diff for remaining unconditional GitHub assumptions; retain intentional references in the optional adapter, migration, and historical records.


## Verification and completion criteria

Extend meaningful cases in `tests/deployment.spec.ts`, `environment.spec.ts`, `runtime.spec.ts`, `runtime-concurrency.spec.ts`, `settings.spec.ts`, `migration.spec.ts`, `assessment.spec.ts`, directory-leasing/crash tests, report/resource tests, prompt tests, and panel tests. Update shared fixtures so ordinary runtime tests do not all receive a ready synthetic GitHub account by default. Include missing process-owner provider cases explicitly; fixtures that supply deterministic proof must be identified as contract tests.

Required integration scenarios:

1. **Feishu only:** GitHub integration off, GitHub plugin absent, no accessible `gh` executable or GitHub tokens. Start core and main Session; admit an authorized request; execute in a plain dedicated directory; report ready without a PR; deliver the result to the originating Feishu conversation. With the production process-owner provider installed, verify release with trusted evidence, then reopen the completed Ticket through an authorized follow-up and actually execute in the same directory. Recording a resumed Ticket without running its worker does not satisfy the reopen check.
2. **No Sources:** start an empty deployment, open its main Session, and use management settings without a GitHub warning or crash. Do not claim automatic intake exists until a Source is enabled.
3. **Local Git:** GitHub off, explicit local author/context directory, and a prepared local worktree. Admit from bounded local context, make and validate a change, commit locally, and deliver the local result without GitHub API calls. Reject escaping paths, unknown Git state where required, and missing commit identity when a commit is required.
4. **GitHub delivery with intake off:** GitHub ready and Feishu intake enabled. Expose the right repository/account environment and allow the authorized GitHub deliverable; verify no GitHub Source poller starts. Show that automatic PR monitoring is off.
5. **GitHub regression:** intake on; preserve notification routing, PR ownership/branch checks, CI, merge/close lifecycle, and source-conversation delivery.
6. **Failures and transitions:** a broken GitHub account does not stop Feishu or hide the main Session. Disable/re-enable GitHub, restart with bound PRs and pending delivery, reject repository changes with open or ended resumable GitHub Tickets/history, cancel stale probes, and confirm no false PR closure or personal credential fallback. For both GitHub SSH remote URL forms, verify retained HTTPS rewrites prevent SSH invocation after disabling and no old credential helper runs; use isolated credentials and stub transports so the test never accesses personal accounts.
7. **Directory invariants:** plain directories and local worktrees retain placement, affinity, lease exclusivity, restart recovery, and fail-closed release behavior. With a production process-owner provider, verify default-directory release/reopen and recovery after controlled restart and host crash, including outstanding hooks and worker descendants. Without a provider, recorded owner, or valid proof, verify release/recovery remains quarantined and follow-up execution is blocked while core and main Session remain available. Neither allocation policy may bypass missing process-owner evidence; fixed inventory additionally requires the unfinished occupancy/admission integration identified in `ticket-directory-leasing-plan.md`.
8. **No Git installed:** remove both `git` and `gh` from Superagent's verification and worker PATH. Start core and main Session, admit a plain-file request, prepare a confirmed non-Git dedicated directory, execute the change, and report and deliver the result without any Git invocation. Keep DSH's own prerequisites separate. Verify that an actual Git directory, inherited ancestor checkout, unreadable marker, or failed Git inspection remains unavailable when Git is missing; then verify normal Git credential checks still run for repositories when Git is present. Changing a directory from non-Git to Git must trigger revalidation.

For live checks, launch the built bundle in an isolated real DSH profile and view Overview, Sources, Deployment, Execution, prompt previews, and Open main Session in a browser. Capture the GitHub-free ready state and an actual local Ticket result. Verify disabling GitHub removes its managed credentials and skill files while retaining the SSH-to-HTTPS rewrites, then repeat with GitHub enabled. Use a real model for the end-to-end worker turn; deterministic CLI fixtures cover unavailable/transition cases but do not count as live GitHub or Feishu integration evidence. Record the production process-owner provider and actual release/recovery evidence for reopen and restart scenarios; a fixture returning a proof string is not live process-containment evidence. A missing provider leaves those scenarios blocked even for default directories. A live Feishu delivery test requires an authorized test conversation; record that gap if none is available.

The change is complete when GitHub can be entirely absent from deployment and operation, plain-file execution works without Git, Feishu/local execution passes end to end, optional GitHub behavior retains its supported workflow, and the documented setup paths match the actual panel and runtime. Completed-Ticket execution after reopen and execution-directory restart recovery require verified production process-owner integration for default directories too; keep completion open while those required scenarios are blocked.
