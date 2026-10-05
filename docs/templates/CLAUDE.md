<!--
  TEMPLATE — copy this to `<your repo>/CLAUDE.md` and edit it.

  This file is loaded into EVERY Claude Code session in this repository, so its
  token cost is paid on every turn. Keep it to what any assistant needs to work
  here correctly. Pipeline-specific instructions belong in `.claude/delivery.md`
  instead, which is read only when a delivery agent runs.

  It is also injected into every agent a workflow dispatches, so a large one is
  paid again per agent. Keep it an index: commands, hard rules, and one line per
  topic pointing at a file (e.g. docs/agents/testing.md) that agents read only
  when the task touches that topic.

  `AGENTS.md` is the equivalent filename read by some other tools; the delivery
  plugin reads whichever it finds, preferring CLAUDE.md.

  Delete every section you do not need, and delete these comments.
-->

# <project name>

<!-- One or two sentences: what this is and who uses it. -->

## The one thing that cannot be undone

<!--
  If your project has an irreversible mistake available to it — committing
  restricted material, truncating a production database, publishing to a package
  registry — say so FIRST and say why it cannot be undone. Everything else in this
  file is recoverable; this is not.

  State it as an ALLOWLIST wherever you can. A denylist is only as complete as the
  person who wrote it, and an agent will reasonably treat an unlisted file as
  permitted.

  If your project has no such hazard, delete this section.
-->

## Layout

<!--
  If this is more than one toolchain, say so explicitly and say there is no
  repo-wide script. That single fact prevents a whole class of wasted turns.
-->

| | `<dir>/` | `<dir>/` |
|---|---|---|
| Stack | | |
| Package manager | | |
| Tests | | |
| Lint / types | | |

## Commands

<!--
  Exact command lines, copy-pasteable, including the directory to run them from
  and any interpreter path. If a bare `pytest` / `node` / `go` resolves to the
  wrong binary here, say so and give the form that works — that failure reads like
  a missing dependency and sends people to reinstall things.
-->

```bash
# Test
<command>

# Lint  — scope to changed files if the tree has pre-existing findings
<command>

# Typecheck
<command>

# Build
<command>

# Run it locally
<command>
```

Coverage floor: `<number>`, **enforced / not enforced**.

## Conventions

- **Branches** — `<pattern>`; PRs into `<default branch>` with `Closes #N`.
- **Changelog** — `<shared CHANGELOG.md / per-PR fragments under changes/ / none>`.
  <!-- If fragments: give the pattern and the validator command, and say that a
       misnamed fragment is silently skipped at assembly. -->
- **Migrations** — every schema change needs a migration with a *working, tested*
  rollback.
- **Scoping** — scoped queries must filter on `<scope column>`, not just the entity
  id. Getting this wrong is how one tenant's record satisfies another's gate.
- **Formatting** — do not reformat files you did not come to change.
- **Docs** — update `<paths>` for architectural or user-facing changes.

## CI

<!--
  Where jobs run, roughly how long a full run takes, and — if you use self-hosted
  runners — how to tell a deep queue from an outage. They look identical from
  `gh pr checks`, and an agent that guesses will report one as the other.
-->

## Known gotchas

<!--
  Things that are true, non-obvious, and not discoverable by reading the code. One
  line each, with the reason it bites. State the SHAPE of a past incident rather
  than its issue number — a bare `#412` is meaningless to anything outside this
  repository.
-->

- `<gotcha>` — `<why>`

## Trust these instructions

Prefer what is written here over searching the codebase to rediscover it. If you find
something here that is wrong, fix this file as part of your change.
