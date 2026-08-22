<!--
  TEMPLATE — copy this file to `<your repo>/.claude/delivery.md` and edit it.

  This file is OPTIONAL. If it does not exist, nothing happens and the delivery
  pipeline falls back to CLAUDE.md alone. Its absence is completely harmless.

  What it is for: delivery-pipeline constraints that every dispatched agent should
  carry, but that do not belong in CLAUDE.md — because CLAUDE.md is loaded into
  EVERY session's context and pays its token cost on every turn, whereas this file
  is read only when a delivery agent actually runs.

  How it is used: the Preflight phase of /delivery:orchestrate and
  /delivery:plan-epic reads this file and quotes it VERBATIM into every subsequent
  prompt. So write it as instructions to an agent, not as notes to yourself.

  Commit it. It describes the project, not your machine.

  Delete every section you do not need, and delete these comments.
-->

# Delivery pipeline constraints

## Gates that are enforced

<!--
  State the exact command lines. Do not paraphrase — a paraphrased command is a
  wrong command. Include the working directory and any interpreter path.
-->

- Tests: `<exact command>`
- Lint: `<exact command>` — **scope it to changed files**, because `<why>`
- Typecheck: `<exact command>`
- Build: `<exact command>`

Coverage floor: `<number>`, **enforced / not enforced** in CI.

If a gate fails, do not push. Report the failure with its output rather than
describing it.

## Pull requests

- Branch naming: `<pattern>`
- Push to remote `<name>` explicitly; do not rely on a default.
- Every PR body must contain `Closes #<issue>`.
- Changelog: `<shared file / per-PR fragment pattern / none>`.
  <!-- If fragments: give the filename pattern and the validator command. -->
- Do **not** merge. Merging is the maintainer's decision.

## Review emphasis

<!--
  Tell the reviewer where to spend its attention. Generic OWASP coverage is
  already in the skill; this is for what THIS codebase actually gets wrong.
  Describe the SHAPE of past defects, not their issue numbers.
-->

- `<defect class that recurs here, and how to detect it>`
- `<a check that has repeatedly paid off>`

## Protected paths

<!--
  State this as an ALLOWLIST wherever possible. A denylist is only as complete as
  the person who wrote it, and an agent will reasonably treat an unlisted file as
  permitted.
-->

- `<what may be read, and from where>`
- `<what must never be committed, and why it cannot be undone>`

## Working tree

- This checkout **is / is not** shared with other sessions. If it is shared, do not
  `git checkout` in it — create a worktree with `git worktree add` and remove it when
  done, and stage explicit paths rather than `git add -A`.

## CI

- Runners: `<GitHub-hosted / self-hosted>`.
- <!-- If self-hosted: how to tell a deep queue from an outage. They are
     indistinguishable from `gh pr checks`, and a guess will be reported as fact. -->
- Expect a full run to take about `<duration>`.

## Known traps

<!--
  Things that have cost an implementer real time here and are not discoverable by
  reading the code. One line each, with the reason.
-->

- `<trap>` — `<why it bites>`
