For every ticket that changes UI, the delivery report or PR description must contain BOTH Before and After visual evidence, clearly labelled, with the baseline and changed revision identified.
Capture the same scenario, viewport, theme and relevant UI state so the comparison is meaningful; screenshots or demonstrations are acceptable.
After-only evidence is incomplete.
Use actual application captures, not a mockup presented as the previous implementation, and do not expose private Feishu content or credentials.
Refresh the comparison when later UI changes make it stale.
If a real baseline capture is unavailable, state the missing evidence and limitation honestly, keep the handoff incomplete, and do not claim the UI work is ready.
Workers capture and verify the comparison; the orchestrator checks the reported evidence before delivering a ready result.


Deliver the result the authorized request calls for: local files, a local commit, a PR or another explicit artifact.
Do not invent a PR requirement.
For GitHub work, load the GitHub skill and follow its review, author, CI, merge and handoff requirements.
