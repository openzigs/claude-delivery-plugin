---
name: retro
description: What the reviews found across saved /delivery:orchestrate runs, and what that suggests changing in the project. Use when the maintainer asks what keeps blocking PRs, why fix cycles fail, whether the size routing is firing, or what to add to .claude/delivery.md. Takes result files or directories, or --discover for the runs Claude Code saved for this project, runs the plugin's own findings script, and shows its report. Read-only; it proposes edits and makes none.
argument-hint: "<result.json | task.output | dir>... | --discover [--last N] [--no-notes]"
---

# Retro

Shows how often a PR went to a fix pass, how often it was still blocking afterwards, which class
of defect blocked it and where in the tree, which routes never fired, and the project notes the
reviews themselves suggested. Every count and every class is computed by
`scripts/findings-report.mjs`. You run it and show what it prints; you do no arithmetic and no
classification of your own.

The arguments for this run: `$ARGUMENTS`

## This skill is read-only

Run the report script and nothing else. Do not edit or create files, do not run any GitHub
command, and do not hand the work to another agent. The script is the only reader of the result
files: do not open them yourself with Read, `cat` or any other tool, because they hold the review
and implementer text of every run.

**Nothing is written to `CLAUDE.md`, `AGENTS.md` or `.claude/delivery.md`.** Those files are the
project's authority and only the maintainer changes them. This skill ends at a proposal.

## With no arguments

If the arguments above are empty, print the usage below and stop. Read nothing.

> **Usage:** `/delivery:retro <result.json | task.output | dir>... [--no-notes]`
> or `/delivery:retro --discover [--last N] [--no-notes]`
>
> Pass the same files `/delivery:cost-report` takes: a run's saved result, its task output, or a
> directory of them. `--discover` reports the runs Claude Code saved for this project;
> `--last N` keeps the newest N. `--no-notes` leaves out the notes the reviews suggested.

## With arguments

Pass every argument through, each path single-quoted, in the order given:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/findings-report.mjs" '<path>' '<path>'
```

With `--discover`, and only when the maintainer passed it, run the script with it and no paths:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/findings-report.mjs" --discover --last '<n>'
```

Add `--last` or `--no-notes` only if the maintainer passed it. Do not add `--json`.

Show the script's standard output verbatim in one fenced code block. If it wrote to standard
error, show those lines below the block. `no runs found under <dir>` means nothing was found,
not that nothing went wrong in the runs.

## After the block

Write at most one short paragraph, and only from what the output itself says:

- Take the lines under **what this suggests** as they are. Do not add a suggestion the script did
  not print, and do not recompute or reinterpret a figure.
- If the maintainer asked what to add to `.claude/delivery.md`, draft the lines **in your reply**,
  under the template's own headings (`Review emphasis`, `Known traps`, `Gates that are enforced`),
  from the suggestions and the repeated notes. Say that the classes are keyword counts and that a
  note which appears once is one review's opinion. Then stop: the maintainer applies it.
