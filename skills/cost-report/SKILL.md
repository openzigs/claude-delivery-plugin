---
name: cost-report
description: Per-run, per-phase cost report over saved /delivery:orchestrate and /delivery:plan-epic result JSON. Use when the maintainer wants to see output tokens, effort, model and finding counts per phase, or compare them across runs after a routing or effort change. Takes result files or directories as arguments, runs the plugin's own report script on them, and shows its table. Read-only.
argument-hint: "<result.json | task.output | dir>... [--include-concurrent] — e.g. runs/2026-10-22-orchestrate-14.json"
---

# Cost Report

Shows what a saved workflow result measured: per run, per phase, the output tokens, effort,
model and finding counts, then the totals and the per-phase trend across runs. The parsing and
every sum are done by `scripts/cost-report.mjs`. You run it and show what it prints; you do no
arithmetic of your own.

The arguments for this run: `$ARGUMENTS`

## This skill is read-only

Run the report script and nothing else. Do not edit or create files, do not run any GitHub
command, and do not hand the work to another agent. The script is the only reader of the result
files: do not open them yourself with Read, `cat` or any other tool.

**Show only the metrics fields.** A result also holds the `research`, `plan`, `review` and
`implemented` text of its run, which can be long or sensitive; never show, quote or summarise
that text. The script's output carries only metrics, so showing it as printed is enough.

## With no arguments

If the arguments above are empty, print the usage below and stop. Do not go looking for
results: not in the working directory, not in the session transcripts under `~/.claude/projects`,
nowhere. Read nothing outside the paths you were given.

> **Usage:** `/delivery:cost-report <result.json | task.output | dir>... [--include-concurrent]`
>
> When a `/delivery:orchestrate` or `/delivery:plan-epic` run finishes, Claude Code writes the
> run's task output to a `<task-id>.output` file, at the path printed in the workflow's
> completion notice. Pass that file straight in; the report reads the result inside it and names the run by
> the wrapper's own run or task id. Or copy the result object the run returned into a `.json`
> file of its own, one file per run, for example `runs/2026-10-22-orchestrate-14.json`. A
> directory argument reports every `*.json` and `*.output` directly inside it, sorted by file
> name, and that order is the order of the trend, so name the files to sort in run order.

## With arguments

Pass every argument through, each path single-quoted, in the order given:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cost-report.mjs" '<path>' '<path>'
```

Add `--include-concurrent` only if the maintainer passed it. Do not add `--json`: the table is
what the maintainer reads.

Then show the script's standard output verbatim in one fenced code block, ending with its caveat
line. If it wrote to standard error, show those lines too, below the block; each one names a path
it could not read or a file that was not valid JSON. Exit status `2` means a bad option or no
paths: show its usage line. Exit status `1` means at least one path could not be read, and the
rest still reported.

After the block, add at most two sentences, and only from what the output itself says:

- A run marked `CONCURRENT` ran batches at the same time, so its token figures include the
  other batches' spend; it is left out of the trend unless `--include-concurrent` was passed.
- `not measured` means the runtime gave no budget for that phase; it is not zero. `n/a` means
  the workflow never records that field for that phase.

Do not recompute, re-total or reinterpret a figure.
