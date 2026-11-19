---
name: doctor
description: Checks whether this repository is ready for /delivery:orchestrate and where a run would spend money it does not need to. Use before the first run in a repository, or when runs are slow, expensive or keep reporting CI as not verified. Runs the plugin's own read-only check script and shows its lines. It reports the instruction file's size, .claude/delivery.md, shadowed agents, whether CI runs on pull requests and how long it takes, and how many open issues carry a Story Points line. Changes nothing.
argument-hint: "[--no-gh]"
---

# Doctor

Every measurement and every threshold is in `scripts/doctor.mjs`. You run it and show what it
prints; you measure nothing yourself.

The arguments for this run: `$ARGUMENTS`

## This skill is read-only

Run the check script and nothing else. Do not edit or create files, do not run any GitHub
command of your own, and do not hand the work to another agent. The script reads files under the
current directory and makes read-only `gh` queries (the repository, its recent pull-request CI
runs, its open issues); it changes nothing.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

Add `--no-gh` only if the maintainer passed it; it skips the GitHub queries and reports the
local checks alone. Do not add `--json`.

Show the script's standard output verbatim in one fenced code block.

## After the block

For each `WARN` line, and only those, add one sentence saying what to do, taken from the line
itself. Where a fix is a file to write, name the template: `docs/templates/CLAUDE.md` or
`docs/templates/delivery.md` in the plugin. Do not write the file, and do not reinterpret an `OK`
or `INFO` line as a problem.

What each line rests on, if the maintainer asks:

| Line | Why it matters |
|---|---|
| Instruction file size | `CLAUDE.md` is injected into every dispatched agent and re-read on every turn; it is the largest fixed cost of a run |
| `.claude/delivery.md` | Where gate commands, owner-only criteria and known traps go without growing `CLAUDE.md` |
| Shadowed agents | A file in `.claude/agents/` with a plugin agent's name replaces it, silently |
| CI on pull requests | With none, the implementer's CI wait finds no checks and CI is reported as not configured |
| Median CI duration | One CI wait is at most 270 s, to stay inside a dispatched agent's 5-minute prompt cache; the implementer makes at most 8 |
| Story Points coverage | An issue with no points line takes the full review on the session model, whatever its size |
