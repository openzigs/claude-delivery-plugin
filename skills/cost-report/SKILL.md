---
name: cost-report
description: Per-run, per-phase cost report over saved /delivery:orchestrate and /delivery:plan-epic result JSON. Use when the maintainer wants to see output tokens, effort, model and finding counts per phase, or compare them across runs after a routing or effort change. Takes result files or directories as arguments, or --discover to find the runs Claude Code persisted for this project, runs the plugin's own report script, and shows its table. Read-only.
argument-hint: "<result.json | task.output | dir>... | --discover [--last N] [--since DATE] [--include-concurrent] [--verbose]"
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
nowhere. Read nothing outside the paths you were given. The one search is `--discover`, and it
runs only when the maintainer passed `--discover`; never add it yourself.

> **Usage:** `/delivery:cost-report <result.json | task.output | dir>... [--include-concurrent] [--verbose]`
> or `/delivery:cost-report --discover [--last N] [--since DATE]`
>
> When a `/delivery:orchestrate` or `/delivery:plan-epic` run finishes, Claude Code writes the
> run's task output to a `<task-id>.output` file, at the path printed in the workflow's
> completion notice. Pass that file straight in; the report reads the result inside it and
> names the run by the wrapper's own run or task id. Or copy the result object the run returned
> into a `.json` file of its own, one file per run, for example
> `runs/2026-10-22-orchestrate-14.json`. A directory argument reports every `*.json` and
> `*.output` directly inside it. Runs are ordered by start time when every one records it, and
> otherwise in the order given (a directory's files sorted by name), so name copied files to sort
> in run order. Files in a directory that are not a delivery result are counted on one
> `skipped` line; `--verbose` lists them.
>
> `--discover` instead reports the runs Claude Code saved for this project, oldest first;
> `--last N` keeps the newest N and `--since DATE` those started on or after DATE.

## With arguments

Pass every argument through, each path single-quoted, in the order given:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cost-report.mjs" '<path>' '<path>'
```

Add `--include-concurrent` or `--verbose` only if the maintainer passed it. Do not add `--json`:
the table is what the maintainer reads.

## With --discover

Only when the maintainer passed `--discover`, run the script with it and with `--last` and
`--since` if given, each value single-quoted, and no paths:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cost-report.mjs" --discover --last '<n>'
```

The script reads only `<config>/projects/<this project>/<session>/workflows/wf_<run-id>.json`,
where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude`; it never opens a transcript. That
layout is undocumented and may change between Claude Code versions, so files that do not fit
are skipped and counted. If it prints `no runs found under <dir>`, show that line: it means
nothing was found, not that the runs cost nothing.

Then show the script's standard output verbatim in one fenced code block, ending with its caveat
line. If it wrote to standard error, show those lines too, below the block; each one names a path
it could not read or a named file that was not valid JSON. Exit status `2` means a bad option
or no paths: show its usage lines. Exit status `1` means at least one path could not be read, and the
rest still reported.

After the block, add at most two sentences, and only from what the output itself says:

- A run marked `CONCURRENT` ran batches at the same time, so its token figures include the
  other batches' spend; it is left out of the trend unless `--include-concurrent` was passed.
- `not measured` means the runtime gave no budget for that phase; it is not zero. `n/a` means
  the workflow never records that field for that phase.

Do not recompute, re-total or reinterpret a figure.
