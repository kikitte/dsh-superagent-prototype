# GitHub optional implementation evidence

Verified on 2026-11-16, Asia/Shanghai, using Node and real DSH 0.2.2-rc.3. The implementation is present; full plan completion remains open for the blocked production lifecycle and remote integration checks below.

## Automated verification

`pnpm check` passed: TypeScript, 65 test files / 1,307 tests, and the bundle build. `git diff --check` passed. New cases cover fresh settings, schema 10/11 account migration and preserved audit history, disabled drafts, concurrency and origin guards, retained ended PR history, bounded local reads, missing Git, SSH rewrites after disablement, PR-report atomicity, stale account results, synchronous Cordis disposal, and missing process-owner quarantine. Ordinary shared-host tests now start without GitHub access by default. Directory tests with simulated owner evidence remain contract tests.

The SSH transport test uses an isolated HOME, stub SSH/HTTPS transports and the old helper. Both `git@github.com:` and `ssh://git@github.com/` reach the stub HTTPS transport after disabling; neither SSH nor the old helper runs. No personal accounts or network are involved.

## Real DSH and model runs

The isolated profiles and working directories are under `/tmp/superagent-github-optional-tsxn2qwz`. Reviewable, credential-free artifacts were copied to `.artifacts/github-optional-verification/`. Model/network access was real: the configured GPT-6.1 Sol model assessed the requests, invoked worker tools and reported results. Intake and delivery used an explicit local test Source and local NDJSON sink; these runs do **not** establish live Feishu or GitHub integration.

| Scenario | Actual evidence |
| --- | --- |
| No incoming Sources, both integration plugins absent | Core `ready`, actual main Session available, GitHub `off`, no integration problem. State: `state-ready.json`. Browser opened the main Session. |
| Plain-file execution without GitHub | Ticket `66586643434641bb5f8f88a591fe911b` completed. Worker wrote and byte-validated `Hello from a GitHub-free Ticket\n`, reported ready without a PR, and the main Session delivered the result to the local adapter. `ticket-detail.json`, `plain-file-result.txt`, `local-delivery.ndjson`. |
| Local Git, GitHub off | Ticket `209d18ea51b2c10319fa34a1fc612177` completed in a worktree prepared from a local clone. Explicit `Local Test <local-test@example.com>` author; commit `08e976fb98103cb84ec261f1366a09ab0569a655`; exact `Updated local note\n`; clean working tree. `localgit-final-ticket.json`, `local-git-result.txt`, local delivery record. No remote push or GitHub operation was requested or used. |
| No Git installed on the configured PATH | A separate real DSH process used a restricted executable directory containing no `git` or real `gh`, plus the managed unavailable `gh` shim. Core and main Session started. Ticket `26d2b676f988ad7f950401ed64f577c0` completed in an ordinary directory and byte-validated `Hello without Git\n`; the main Session delivered it locally. `nogit-state.json`, `nogit-final-ticket.json`, `no-git-result.txt`. No DSH prerequisite failure prevented this run. |
| GitHub access independent of intake/plugin | A deterministic, network-free CLI fixture supplied identity/push responses in real DSH. Access became ready with intake off and the Source plugin absent; identity environment, helper and GitHub skill were available. `github-enabled-fixture-state.json`. This is transition evidence, not live GitHub authentication. |
| Disable with an invalid saved CLI | Controlled in-process restart completed. Core/main stayed available after restart, managed helper and active GitHub skill disappeared, and both HTTPS rewrites remained. `github-disabled-fixture-state.json`. No old CLI probe was needed to disable. |
| Missing process-owner evidence | After real execution, leases remained `releasing` / recovery `quarantined`, with an actionable missing-proof error. Core/main remained ready across subsequent integration restarts. `directory-evidence.json` and the Ticket lease records. This confirms fencing, not successful recovery. |

The local Git run used a separate state directory because changing default preparation while the previous lease was unreleased was correctly refused. No lease, affinity, occupancy or recovery rule was bypassed.

The live transition check exposed an existing synchronous-disposal assumption in Session cleanup. It was fixed, and enable/disable was rerun successfully. Management routes now unregister even if other shutdown cleanup fails. Generation checks fence old account results as soon as changed settings are saved.

## Browser comparison

Actual Chrome captures use a 1500 × 1000 viewport and light theme. The **Before** build is repository revision `23ce5b6a68478f6b5a02675d603f4df1d2f02347`, built separately with the same DSH/model setup. The **After** build is the implementation working tree. Both comparison views have GitHub/Feishu unavailable and no running Sources; the after view retains the completed local test history with its local test Source disabled.

- **Before:** [GitHub-free deployment blocked](../.artifacts/github-optional-verification/before-no-github-overview.png). Missing repository prevents core work and main Session navigation.
- **After:** [GitHub-free deployment ready and idle](../.artifacts/github-optional-verification/after-no-github-overview.png). Main Session navigation is enabled and no GitHub setup error appears.
- Additional actual captures: [Deployment](../.artifacts/github-optional-verification/after-deployment.png), [Sources](../.artifacts/github-optional-verification/after-sources.png), [Execution settings](../.artifacts/github-optional-verification/after-execution-settings.png), [prompt preview](../.artifacts/github-optional-verification/after-prompt-preview.png), [completed local Ticket and retained ownership](../.artifacts/github-optional-verification/after-local-ticket.png), [opened main Session](../.artifacts/github-optional-verification/after-main-session.png).

## Blocked prerequisites and remaining live checks

- **Production durable process-owner provider:** none is shipped or installed. Completed-Ticket execution after reopen, verified release, controlled-restart recovery and host-crash recovery remain blocked for default directories too. DSH's reported weaker process-tree fallback is not durable owner/quiescence evidence. No deterministic proof was substituted. Fixed inventory additionally needs the authoritative cross-runtime occupancy/admission bridge.
- **Live Feishu delivery:** no authorized test conversation was available. Bot-only access, ordinary result delivery and failure isolation have automated coverage; the real local adapter is not Feishu evidence.
- **Live GitHub regression:** no dedicated authorized test repository/account was used. Notification, PR ownership/branch checks, CI and close/merge behavior have regression coverage; the fixture establishes only local transitions and credential routing.

These gaps keep the corresponding plan completion checks open. Isolated test services were stopped after evidence collection; state and quarantined ownership records were retained.
