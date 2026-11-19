# delivery — a Claude Code plugin

A project-agnostic delivery pipeline for Claude Code: two workflows, eight agents and
twelve skills that take a GitHub issue from implementation through **independent review**,
fix and re-review — or turn a topic into a filed epic with sub-issues — plus a read-only
report of what each run cost.

It hardcodes nothing about any project. Every dispatched prompt reads the repository's own
`CLAUDE.md` for its hard rules, so the same plugin works in a Go service, a React app, a
Rust CLI or a polyglot monorepo.

This README is the user guide: you can install, run and read the results of every command
from it alone. [`docs/`](docs/) holds the detailed reference, linked from each section.

**Contents:** [Why this exists](#why-this-exists-claude-code-cannot-invoke-an-agent-directly) ·
[Install and update](#install-and-update) · [The commands](#the-commands) ·
[A typical loop](#a-typical-loop) · [What a result contains](#what-a-result-contains) ·
[Agents and skills](#agents-and-skills) · [Verifying it loaded](#verifying-it-loaded) ·
[MCP servers](#mcp-servers-what-this-plugin-needs-and-what-it-merely-uses) ·
[Many issues, one short session at a time](#many-issues-without-one-endless-session) ·
[Per-project configuration](#per-project-configuration) ·
[Precedence and gotchas](#precedence-and-gotchas) · [Releases](#releases) ·
[Contributing](#contributing)

---

## Why this exists: Claude Code cannot invoke an agent directly

**There is no `/agent-name` syntax.** You cannot type a subagent's name to run it. No
setting, no hook, no convention, no line in a `CLAUDE.md` influences which agent gets
dispatched. Dispatch is *purely* the main model reading the `description` field of each
available agent and choosing one — or choosing none and doing the work itself.

The consequence is uncomfortable and easy to miss:

> **A pipeline written as a convention is only ever a request.**

If your `CLAUDE.md` describes a nine-phase delivery process, nine phases do not happen.
Some subset happens — the subset the model felt like doing on that turn. And the phases
that go missing are systematically the ones that produce no artifact anyone is waiting for:
**review** and **security audit**. A phase nobody remembers to invoke is indistinguishable
from a phase that passed. The build is green either way.

**A workflow is different. A workflow is a command.** You type `/delivery:orchestrate 412`
and a JavaScript file runs. Its phase sequence is code, not intention:

```js
const built = await agent(/* ... */, { phase: 'Implement', agentType: 'delivery:code-issue' })
for (const it of built.issues.filter((i) => i.pr))
  await agent(/* ... */, { phase: 'Review', agentType: 'delivery:code-review' })
```

The review phase cannot be skipped, because skipping it would require the script not to
execute a line. One opt-in flag weakens the *per-PR* part of that guarantee:
**`--batch-review`** (experimental, off by default) reviews a batch of PRs in one review
instead of one each. It is cheaper, but one reviewer's attention is spread over several
changes, so a defect is likelier to be missed; it is ignored for a batch with a risk label,
and a PR it blocks still gets its own fix and re-review. That is why this plugin is packaged as workflows that dispatch agents: the
agents are the workers the workflows dispatch, and the skills are the procedures those
workers follow.

---

## Install and update

### Install from the marketplace

This repository is both the plugin and a single-plugin marketplace that serves it. From a
terminal:

```bash
claude plugin marketplace add openzigs/claude-delivery-plugin
claude plugin install delivery@claude-delivery-plugin
```

or, inside an interactive session:

```
/plugin marketplace add openzigs/claude-delivery-plugin
/plugin install delivery@claude-delivery-plugin
```

Add `--scope project` to the CLI install to declare it in the repository's committed
settings, so everyone working in that repository gets it.

### Update

Inside a session, run these two commands, each at the very start of the line — a slash
command with a space before the `/` is sent as an ordinary message and does nothing:

```
/plugin marketplace update claude-delivery-plugin
/reload-plugins
```

**A session that is already open keeps the copy it loaded until you reload it.** Updating
from a terminal (`claude plugin marketplace update claude-delivery-plugin`, then
`claude plugin update delivery`) changes what the *next* session loads; any session already
running still behaves like the old version until you run `/reload-plugins` in it or restart it.

### Try it without installing

```bash
claude --plugin-dir /path/to/claude-delivery-plugin
```

That loads the plugin from a checkout for that one session. The directory is read at session
start, so restart after editing anything in it.

IDE extensions, private-repository access and scopes are covered in
[`docs/installation.md`](docs/installation.md).

---

## The commands

Three commands are typed: two workflows and one reporting skill. Arguments go after the
command on the same line.

| Command | What it does | Ends at |
|---|---|---|
| `/delivery:orchestrate` | Implement → Review → *(Fix → Re-review, only on a blocking finding)*, per PR | One open, reviewed PR per issue, **never merged** |
| `/delivery:plan-epic` | Research → Plan | A filed epic with sub-issues, **no code written** |
| `/delivery:cost-report` | Reads saved run results and tabulates tokens, effort, model and findings per phase | A table on screen; reads files only |

### `/delivery:orchestrate` — issues to reviewed pull requests

```
/delivery:orchestrate 412                     one issue
/delivery:orchestrate 412 413 415             one batch: one implementer, one PR per issue
/delivery:orchestrate 412 413 ; 500 501       two batches, run concurrently in separate worktrees
/delivery:orchestrate 412 --points 2          size hint for that batch (or --small)
/delivery:orchestrate 412 --small-model haiku the small tier's model: sonnet (default), inherit or haiku
/delivery:orchestrate 412 --small --small-effort medium
                                              the small-tier implementer's effort: high (default) or medium; unmeasured
/delivery:orchestrate 412 413 --batch-review  experimental cheap mode: one review for the whole batch
/delivery:orchestrate --pr 88 89              pull requests that already exist: review, fix, re-review; no implement
/delivery:orchestrate --epic 47               the epic's open sub-issues, batched by their dependencies
/delivery:orchestrate 412 413 --triage        read each issue's story points first, so size routing needs no hint; unmeasured
/delivery:orchestrate 412 413 --per-issue     a fresh implementer per issue instead of one for the batch; unmeasured
/delivery:orchestrate 412 --e2e               Playwright specs for a UI-labelled PR, before its review
/delivery:orchestrate make the audit filter honour a date range
                                              a description: the implementer files the issue first
```

`#412` is the same as `412`. With no argument it uses what you described in the
conversation.

**Phases, per pull request:**

1. **Implement** — `delivery:code-issue` works each issue in the batch in turn: TDD with
   tests shown to fail, the project's coverage and lint gates, a branch, a PR with
   `Closes #N`, and CI watched to green. It reports each issue's story points and labels and
   each PR's size, which the later phases route on.
2. **Review** — `delivery:code-review` reads each PR independently and publishes inline
   comments. It is **light** (requirements, correctness, tests and security of the changed
   lines) only for a small, low-risk change: the issue's `Story Points` line ≤ 2, no risky
   label, and the PR at most 5 files and 150 changed lines. Anything else, or anything
   unknown, gets the **full** review. A label is risky when it *contains*, case-insensitively,
   any of `secur`, `auth`, `migrat`, `breaking`, `payment`, `billing`, `privacy`, `infra` or
   `data-loss`, so `Security`, `authentication`, `db-migration` and `infrastructure` all
   count. The match errs towards a full review: `author-feedback` counts too.
3. **Fix** — only when the review flags a blocking finding. `delivery:code-issue`, in the
   skill's *Fix mode*, fixes or declines each finding with a reason, re-runs the gates and
   pushes to the PR's existing branch. It opens no new branch or PR.
4. **Re-review** — `delivery:code-review` checks the fix. That is cycle 2 of a **maximum
   of 2**; anything still blocking after it is left for you, not a third automated pass.

**Who can clear a blocker.** Each blocking finding says whether the author can clear it, or only
the owner (an approval, a check on a real device), or only time (CI still running, an outage).
A fix pass starts only when something is the author's: a PR blocked solely on you or on a wait
gets no fix and no re-review, and is listed in the result's `awaitingOwner`. The fix agent is
given the blocking findings and the non-blocking ones at `medium` or above; `low` and `nit`
stay on the PR as inline comments for you (`withheldFromFix` counts them). A fix larger than the
light-review limit (5 files, 150 lines) is re-reviewed as new code, on the session model at
`high`, instead of by a confirming pass.

**Entry points and opt-in phases.**

- **`--pr 88 89`** takes pull requests that already exist through review, fix and re-review,
  with no implement phase: a PR an earlier run left blocking, or one a person opened. The
  numbers are PR numbers; `;` still separates concurrent batches.
- **`--epic 47`** has `delivery:triage` read the epic's sub-issues and builds the batches for
  you: issues that depend on each other share a batch, in dependency order; unrelated ones run
  concurrently, folded into at most four batches. Closed issues and issues with an open PR are
  left out and named in the log.
- **`--triage`** is one `delivery:triage` dispatch on Haiku before anything is implemented. It
  reads each issue's `Story Points` line, so a batch whose every issue is ≤ 2 points is
  implemented on the small tier without `--points`. It also leaves out closed issues, tells the
  implementer about a PR already open, and logs an acceptance criterion only you can meet.
  **Unmeasured**: an earlier sizing agent cost more than it saved, so it is off by default.
- **`--per-issue`** gives each issue of a batch its own implementer, in turn, each told which
  branches the earlier ones produced. **Unmeasured**: on real runs an implementer's context
  reaches a median 385k tokens by the end of one issue and every later turn re-reads it, which
  suggests a shared context costs more than a fresh start, but no replay has compared them.
- **`--e2e`** dispatches `delivery:e2e-test` for each PR whose issue carries a UI label (`ui`,
  `ux`, `frontend`, `client`, `web` or `design` as a whole word), before the review, so the specs
  are reviewed with the change. A PR that gained specs takes the full review.

**Model and effort per phase:**

| Phase | Model | Effort |
|---|---|---|
| Implement | Sonnet with `--small` or `--points N` ≤ 2; otherwise the session model | `high`; a small-tier implementer follows `--small-effort` (default `high`) |
| Review | Sonnet when light; the session model when full | `high` |
| Fix | Sonnet (the session model if Sonnet did the implementing) | `medium` |
| Re-review | Sonnet; escalated to the session model at full scope if the first review was light and still blocked, or if the fix is over 5 files / 150 lines | `medium`, or `high` when escalated |
| Triage (`--triage`, `--epic`) | Haiku | `low` |
| E2E tests (`--e2e`) | The batch's implement model | The batch's implement effort |

**Batches.** Space-separated issues are one batch for one implementer — use it for related
issues that touch the same code. Each issue still gets its own branch and PR, and its own
review — unless you pass `--batch-review`, which reviews a batch with no risk label once.
The result then records `cheapMode: true` and each batch's `reviewMode` (`batch` or
`per-pr`, with the reason). Separate batches with `;` and they run **concurrently**, every agent in its own git
worktree. A size hint belongs to the batch it is written in.

**`--small-effort medium|high`** sets the effort of the small tier's implementer only (a batch
sized `--small` or `--points N` ≤ 2), for the whole run. The default, `high`, is unchanged
behaviour. `medium` is **unmeasured**: it exists so a replay can compare the two
(`bench-run.mjs --orchestrate-args "--small-effort medium"`, see
[benchmarks](docs/benchmarks.md)) before any default changes. Reviews, fixes, re-reviews and
every non-small implementer keep the effort in the table above. Each batch records
`implementEffort` and `implementEffortWhy`, and the cost-report shows both on its Implement row.

**Stacked PRs and merge order.** When an issue in a batch depends on an earlier one that is
not merged yet, its branch is stacked on that issue's branch instead of the default branch,
and the PR body says so. Merge in dependency order: the base PR first, then the stacked one,
once GitHub has retargeted it (or you have rebased it) onto the default branch.

**It stops before merging.** Merging is your decision. The run ends with a result object
(see [What a result contains](#what-a-result-contains)) and a note that nothing was merged.

Details: [`docs/usage.md`](docs/usage.md#deliveryorchestrate--issues-to-reviewed-prs).

### `/delivery:plan-epic` — a topic to filed issues

```
/delivery:plan-epic add SSO with SAML and SCIM provisioning
/delivery:plan-epic ~/Documents/product-requirements/q3-retention
/delivery:plan-epic https://example.com/rfc/audit-retention
```

The argument is a topic, a path to documents, or a URL. **Research**
(`delivery:research`) gathers the local files, web pages, library docs and the repository
itself, including its open backlog so the plan does not duplicate filed work. **Plan**
(`delivery:code-planner`) reads the existing labels, then files an epic and sub-issues with
acceptance criteria, story points, Mermaid diagrams and a phase order.

It **writes no code and opens no pull request**. It returns the research summary, the plan
(with the issue numbers it filed) and the output tokens of each phase. Take the sub-issues
forward with `/delivery:orchestrate`.

### `/delivery:cost-report` — what each run cost

```
/delivery:cost-report <path from the completion notice>/tasks/<task-id>.output
/delivery:cost-report runs/2026-10-22-orchestrate.json
/delivery:cost-report runs/
/delivery:cost-report --discover --last 5
/delivery:cost-report --discover --since 2026-10-01 --include-concurrent
```

It reads finished `/delivery:orchestrate` and `/delivery:plan-epic` runs and prints, per run
and per phase, output tokens, effort, model and finding counts, then totals across runs and a
per-phase trend. It is read-only and does every sum in a script, so no model adds the numbers.

**Inputs:**

- a saved result object (`.json`);
- a finished run's task output, `<task-id>.output` — its path is in the workflow's
  completion notice, and the report reads the result inside the wrapper;
- a directory: every `*.json` and `*.output` directly inside it.

**Flags:**

| Flag | Effect |
|---|---|
| `--discover` | Instead of paths, read the runs Claude Code saved for the current directory's project (under `$CLAUDE_CONFIG_DIR` or `~/.claude`). That layout is undocumented and may change |
| `--last N` | With `--discover`: keep the newest N runs |
| `--since DATE` | With `--discover`: keep runs started on or after DATE, such as `2026-10-01` |
| `--include-concurrent` | Put concurrent runs into the per-phase trend (they are left out by default) |
| `--verbose` | List every skipped file rather than only counting them |
| `--json` | Print the report as JSON instead of tables |

**Reading the output:**

- a number is measured output tokens;
- `not measured` — the runtime gave no budget for that phase. It is not zero;
- `n/a` — the workflow never records that field for that phase;
- `CONCURRENT` — the run had batches running at once, so its token figures include the other
  batches' spend. It is excluded from the trend unless you pass `--include-concurrent`;
- `REVIEW DID NOT RETURN` — that PR was not reviewed, and its findings are not counted;
- the `skipped` line counts files that were not JSON, were not a delivery result (another
  workflow's run, for example), or — with `--since` — a run with no start time, which cannot be
  shown to have started after the date. `--verbose` lists them;
- runs are ordered by start time when every run has one. Under `--discover`, a run with no start
  time is placed first, and the trend header says so, so `--last N` always keeps the newest
  timed runs;
- `no runs found under <dir>` means nothing was found there; `no runs match --since <date>`
  means runs were found but none started on or after that date.

**The proxy caveat**, printed under every report: severity counts are a proxy. A drop in
findings after a routing or effort change does not show whether findings were lost; read the
reviews before concluding a cheaper review is as good.

Details: [`docs/usage.md`](docs/usage.md#reading-the-cost-of-a-run).

---

## A typical loop

```
> /delivery:plan-epic add audit-log retention with a configurable window
  ... Research -> Plan ...   Filed an epic with three sub-issues: 531, 532, 533.

> /delivery:orchestrate 531 532 ; 533
  ... two batches at once; 531 and 532 share an implementer ...
  Three PRs opened and reviewed; one review found a blocking finding, fixed and re-reviewed.
  Nothing was merged.
```

1. **Plan** with `/delivery:plan-epic`.
2. **Orchestrate** the sub-issues. Batch related ones (space-separated) so one implementer
   carries the context; split independent ones with `;` to run them concurrently.
3. **Review and merge** the PRs yourself, base PRs before stacked ones.
   `/delivery:resolve-pr-comments <pr>` works through review threads you or a teammate left.
4. **Update and reload** when the plugin itself changed: `/plugin marketplace update
   claude-delivery-plugin`, then `/reload-plugins`.
5. **Check the cost** with `/delivery:cost-report --discover --last 5`: tokens and findings per
   phase, to judge a routing or effort change by measurement rather than impression.

---

## Many issues, without one endless session

Keeping one session open for weeks does not preserve memory and costs more per step. On real
projects the longest sessions were compacted 12 to 108 times each (about once every 170 model
calls), every call re-read a context of 179k to 617k tokens, each return after more than an hour
re-wrote all of it, and about a third of the calls were status checks on workflows that would
have notified the session anyway. Keep the memory outside the conversation instead:

| What | Where it lives | Who reads it |
|---|---|---|
| What was done and why | GitHub: the issue, the PR body, the published review | Any session, any agent |
| Lessons about the codebase | `.claude/delivery.md` | Every dispatched agent |
| Where the work stands now | `.claude/handoff.md`, written by `/delivery:handoff` | The next main session |

```
/delivery:handoff resume                 start of a session: what the note said, what changed since, the next step
/delivery:orchestrate --epic 47          one command per epic; it notifies when done, so do not poll
/delivery:orchestrate --pr 88 91         send PRs back through review once what was yours is cleared
/delivery:handoff                        before /clear, switching epics, or more than an hour away
/delivery:retro --discover --last 50     weekly: what reviews keep finding, and lines for .claude/delivery.md
```

**To adopt it in a project**, nothing is required, and three things help: add
`.claude/handoff.md` to `.gitignore` (it is working state); create `.claude/delivery.md` from the
[template](docs/templates/delivery.md) and list the criteria only the owner can meet; and give
issues a `Story Points` line. `/delivery:doctor` reports what a repository is missing.

**When to reset:** after an epic's run is dealt with, when switching epics, before more than an
hour away, and once a session has been compacted. Not while a workflow is still running. A rule
of thumb is one session per epic or per working day, whichever is shorter.

The measurements, a worked epic from idea to merged, the full setup table, an example note and the
optional one-line `CLAUDE.md` pointer are in [`docs/long-sessions.md`](docs/long-sessions.md).

---

## What a result contains

`/delivery:orchestrate` returns `{ batches, reviewCompleted, merged: false, awaitingOwner, triage, suggestedProjectNotes, note }`.
`awaitingOwner` lists the PRs blocked only on a person or on time, for which no fix ran; `triage`
holds what `--triage` or `--epic` read, and is `null` without them.
`suggestedProjectNotes` lists the reviews' durable findings, deduplicated across the run — lessons
to copy into your notes or `CLAUDE.md` if you want them; the plugin never writes them there. Each batch
records its `issues`, `implementModel` and `outputTokens.implement`, and a `prs` list. Each PR
entry records:

| Field | What it holds |
|---|---|
| `models` | The model of each phase that ran (`session model` when inherited) |
| `effort` | The effort passed to each phase that ran (`high` or `medium`; runs from before 0.8.0 show `inherit`) |
| `outputTokens` | Output tokens of `review`, and of `fix` / `rereview` when they ran; `null` when the runtime gave no budget |
| `findingCounts` | `{ review, rereview }`, each a count per severity: `critical`, `high`, `medium`, `low`, `nit` |
| `suppressedFindings` | Non-blocking findings dropped for a confidence below 50; blocking findings are never dropped |
| `stillBlocking` | After a re-review: `true` if blocking findings remain, `false` if not; `null` when no re-review ran |
| `awaiting` | Who else must act on a blocker: `owner`, `wait`, both, or `[]` |
| `withheldFromFix` | `low` and `nit` non-blocking findings left on the PR and not given to the fix agent |
| `fixSize`, `reviewedSha` | The fix's own `{ files, lines }`, and the commit the first review read; `null` when not reported |

Also present: `reviewScope` (`light` or `full`) with its `reviewRouting` reason, the review,
fix and re-review outputs, and `reviewCompleted: false` with a note when a review never
returned. `/delivery:plan-epic` returns its `research`, its `plan` (the epic, each filed issue with
its story points and blockers, and what was not filed), `filedIssues`, `missingStoryPoints`,
`next` (the `/delivery:orchestrate` command that takes it forward) and
`outputTokens: { research, plan }`.

The full field table, and why concurrent runs overlap, are in
[What the result measures](docs/usage.md#what-the-result-measures).

---

## Agents and skills

### Agents — the workers

You cannot type an agent. The workflows dispatch them; you can also ask for one in plain
words ("review PR 88"), but then the main model decides whether to use it.

| Agent | What it does | Used |
|---|---|---|
| `delivery:orchestrator` | Points you at `/delivery:orchestrate`; runs the same implement → review → fix → re-review only when the command cannot be used | Directly, when you say "work on issue N" without naming agents |
| `delivery:code-issue` | Implements one issue end to end: TDD, coverage, branch, PR, CI watch | By `/delivery:orchestrate` (Implement, Fix); or directly for a one-off |
| `delivery:code-review` | Reviews a PR against its requirements, OWASP, design, performance and tests; publishes inline comments. No write tools | By `/delivery:orchestrate` (Review, Re-review); or directly before a merge |
| `delivery:code-planner` | Files an epic and sub-issues with diagrams, story points and phase order | By `/delivery:plan-epic` (Plan) |
| `delivery:research` | Turns local files, web pages and library docs into a research summary. Read-only | By `/delivery:plan-epic` (Research) |
| `delivery:e2e-test` | Writes Playwright specs mapped to acceptance criteria | By `/delivery:orchestrate --e2e`; directly; or by `delivery:code-issue` for UI work |
| `delivery:ui-vision` | Drives a real headed browser through a running app and files what it finds. Writes no tests | Directly ("walk through the settings page") |
| `delivery:triage` | Reads issues and reports their state, story points, labels, open PR, dependencies and owner-only criteria, exactly as written. Read-only | By `/delivery:orchestrate` with `--triage` or `--epic` |

### Skills

`code-issue`, `code-review`, `cost-report`, `doctor`, `e2e-test`, `epic-planner`, `handoff`,
`repo-scaffold`, `research-gather`, `resolve-pr-comments`, `retro`, `ui-vision`.

Each is typed namespaced, as `/delivery:<name>`, to run its procedure in the current session,
and is also loaded by the agents that follow it.

| Skill | What it does | Used |
|---|---|---|
| `/delivery:code-issue` | The implement-an-issue procedure: plan, branch, TDD, security scan, CI, PR | Preloaded by `delivery:code-issue`; type it to run the procedure in your session |
| `/delivery:code-review` | The review procedure: requirements, design, OWASP, quality, performance, tests, publish | Preloaded by `delivery:code-review`; type it as `/delivery:code-review 88` |
| `/delivery:cost-report` | The per-run, per-phase cost report above | Typed only |
| `/delivery:doctor` | Is this repository ready for the pipeline: instruction-file size, `.claude/delivery.md`, shadowed agents, CI on pull requests and its duration, story-point coverage. Read-only | Typed before the first run, or when runs are slow or expensive |
| `/delivery:e2e-test` | Acceptance criteria to Playwright specs, Page Object Model, accessible locators | By `delivery:e2e-test`; or typed as `/delivery:e2e-test 412` |
| `/delivery:epic-planner` | Epic and sub-issue structure, Mermaid diagrams, story points, phase order | By `delivery:code-planner` in `/delivery:plan-epic` |
| `/delivery:handoff` | Writes `.claude/handoff.md` (open PRs, open epics, what the last runs left unfinished, your decisions and the next step) so work continues in a fresh session; `resume` reads it back and reports what changed | Typed before `/clear` or the end of a day; `/delivery:handoff resume` at the start of the next |
| `/delivery:repo-scaffold` | A new repository from nothing: stack, scaffolding, CI, and the `CLAUDE.md` this pipeline reads | Typed on an empty repository, or by `delivery:code-planner` |
| `/delivery:research-gather` | Collects and converts research material from files, the web and library docs | By `delivery:research` in `/delivery:plan-epic` |
| `/delivery:resolve-pr-comments` | Triages unresolved review threads, fixes the valid ones, replies and resolves them | Typed after a review: `/delivery:resolve-pr-comments 88` |
| `/delivery:retro` | What the reviews found across saved runs: fix and still-blocking rates, blocking findings by class and area, routes that never fired, and the notes the reviews suggested. Read-only; proposes `.claude/delivery.md` lines and writes none | Typed: `/delivery:retro --discover` |
| `/delivery:ui-vision` | A structured browser walkthrough with screenshots, console capture and bug filing | By `delivery:ui-vision`; or typed with the app running |

The reviewer and the QA agent hold `disallowedTools: Write, Edit` on purpose: removing the
write tools from a reviewer's schema is a stronger guarantee than trusting it not to reach
for them. More in [`docs/usage.md`](docs/usage.md#agents).

**Cost.** Every dispatched agent pays for the project's `CLAUDE.md` before it starts, so the
pipeline keeps the agent count low: no sizing agent unless you pass `--triage`, one implementer
per batch unless you pass `--per-issue`, and a clean issue costs two agents. Output tokens are a
few percent of a run: on real runs an implementer's cost is almost all re-reading its own growing
context, and a third of it was cache re-writes after a wait longer than five minutes, which is why
one CI wait is capped at 270 seconds. The biggest lever is yours: keep `CLAUDE.md` a small index — see
[per-project configuration](docs/per-project-configuration.md#keep-claudemd-small--it-is-the-biggest-cost-lever).

---

## Verifying it loaded

**The failure mode is silence.** A plugin that does not load produces no error; a
misnamed agent simply never appears. Check, do not assume:

```bash
claude plugin list
claude plugin details delivery
# or, from a checkout:
claude --plugin-dir /path/to/claude-delivery-plugin plugin details delivery
```

You should see `Skills (12)` and `Agents (8)`.

`claude plugin details` does **not** list workflows — true of every plugin. To confirm them,
type `/` in a session and look for `/delivery:orchestrate` and `/delivery:plan-epic`. More
checks in [`docs/installation.md`](docs/installation.md#verifying-it-loaded).

---

## MCP servers: what this plugin needs, and what it merely uses

**Nothing here requires an MCP server** except for the two browser agents. Every other step
works with the built-in tools plus the `gh` CLI.

| Server | Used by | Required? |
|---|---|---|
| **Playwright** (`mcp__playwright__*`) | `delivery:e2e-test`, `delivery:ui-vision` | **Yes, for those two** |
| **Tavily** (`mcp__tavily__*`) | `delivery:research`, `delivery:code-planner` | No — an accelerator over `WebSearch` |
| **Context7** (`mcp__context7__*`) | `delivery:research`, `delivery:code-planner` | No — an accelerator over `WebFetch` |
| **GitHub** | *nobody* | No — every agent uses the `gh` CLI |

**A `tools:` allowlist naming `mcp__tavily__*` is a permission, not a promise.** It cannot
conjure a server you have not configured. The two agents that name those patterns are told
to check rather than assume, and to treat them as faster paths rather than dependencies, so
the plugin behaves the same whether or not you have them, only slower.

Registration commands for macOS, Linux and Windows are in
[`docs/mcp-servers.md`](docs/mcp-servers.md).

---

## Per-project configuration

> **Every dispatched agent obeys the project's `CLAUDE.md` (or `AGENTS.md`) exactly**,
> because that is where a project states its own hard rules.

| File | Purpose | If missing |
|---|---|---|
| `CLAUDE.md` or `AGENTS.md` (repo root) | Commands, coverage floors, protected paths, conventions | Gates are inferred from CI config and manifests, and the report says so |
| `.claude/delivery.md` | **Opt-in.** Delivery constraints carried into every dispatched prompt, kept out of the always-loaded `CLAUDE.md` | Nothing happens |

Template: [`docs/templates/delivery.md`](docs/templates/delivery.md). Full explanation:
[`docs/per-project-configuration.md`](docs/per-project-configuration.md).

---

## Precedence and gotchas

Every item here fails **silently**. Read
[`docs/precedence-and-gotchas.md`](docs/precedence-and-gotchas.md) before debugging:

- A project's `.claude/agents/<name>.md` **silently overrides** a plugin agent of the same name.
- **Workflows cannot be symlinked.** Copy them.
- An agent is named by its `name:`, not its file: a mismatch **silently renames** it, so every
  reference written from the filename points at nothing. Keep them equal.
- An orchestrator whose `tools:` omits `Agent` narrates a pipeline and **delegates nothing**.
- Agent references must be namespaced: `Agent(delivery:code-issue)`.
- An explicit `model: inherit` **overrides** `CLAUDE_CODE_SUBAGENT_MODEL`; a model blocked by
  `availableModels` is **substituted**, not refused; plugin agents **ignore** `hooks`,
  `mcpServers` and `permissionMode`.

To fork an agent, override one for a single project or add your own workflow, see
[`docs/customising.md`](docs/customising.md).

---

## Releases

**Bump `version` in `.claude-plugin/plugin.json` for any change in behaviour.** An update can
refresh the same version in place, so without a bump two machines can report one version
while running different code, and nobody can tell which copy produced a result.

### What changed in 0.10.0

Driven by 630 real orchestrate runs (1,589 PRs) and about 9,000 subagent transcripts. The
central finding: output tokens, which the pipeline metered, are a few percent of a run. An
implementer's cost is almost all re-reading its own growing context, and a third of it was
cache re-writes after a wait longer than the 5-minute prompt cache.

- **One CI wait is at most 270 s, repeated up to 8 times** (was one call of up to 600 s). About
  two thirds of the gaps over five minutes followed a CI wait, each paid for with a full
  re-write of the implementer's context.
- **A fix pass runs only for a blocker the author can clear.** Findings carry `resolvableBy`
  (`author`, `owner`, `wait`); a PR blocked only on its owner or on a wait gets no fix and no
  re-review, and is listed in `awaitingOwner`.
- **The fix agent is given blocking findings and non-blocking ones at `medium` or above.** `low`
  and `nit` stay on the PR as comments.
- **A fix over 5 files / 150 lines is re-reviewed as new code**, on the session model at `high`.
- **Two issues in one PR are reviewed once.**
- **New entry points:** `--pr` (existing pull requests: review, fix, re-review) and `--epic`
  (batches built from an epic's sub-issues and their dependencies).
- **New opt-in, unmeasured flags:** `--triage`, `--per-issue`, `--e2e`.
- **New agent `delivery:triage`**, new read-only skills **`/delivery:retro`** and
  **`/delivery:doctor`**, and **`/delivery:handoff`**, which writes a short note so work continues
  in a fresh session instead of one endless one ([why](docs/long-sessions.md)).
- **The implementer** greps the consumers of every contract it changes, and lists each
  acceptance criterion with its test (or as the owner's) in the PR body. **The reviewer** leaves
  a clean tree after its mutation checks and reports the commit it read.
- **`/delivery:plan-epic` returns structure**: the epic, each filed issue's story points, the
  issues filed without a points line, and the next command.
- **The orchestrator agent is a fallback** behind `/delivery:orchestrate`, no longer described as
  the default for "work on issue N". Dispatched by hand it idled for a median 110 minutes holding
  a large context.
- **`resolve-pr-comments`** stages explicit paths, as `code-issue` does, and shares its shell rules.

### What changed in 0.9.1

- **`code-review` `maxTurns` 30 → 130.** 0.9.0 set it from the benchmark fixture, where reviews
  took at most 7 turns. On real repositories completed reviews take up to 64 (p95 38), so the
  cap cut off about 1 review in 7. A review stopped by the cap returns nothing, and the workflow
  reports that it never returned. 130 is twice the highest observed.

### What changed in 0.9.0

One default changed, for every run:

- **`maxTurns` set from replay data.** `code-review` drops from 50 to 30 and `research` from 60
  to 30. The highest observed over the benchmark replays was 7 and 8, on a small fixture, so 30
  leaves headroom for real repositories. `ui-vision` keeps 80 until there is data for it.

New, off by default:

- **`--small-effort medium|high`** sets the effort of the small-tier implementer. The default
  stays `high`: a replay measured `medium` at about 5% (~$0.02) cheaper per small issue, inside
  run-to-run noise, so it is not worth the quality risk by default.

Also in 0.9.0, all maintainer tooling with no effect on a run:
- **Replay isolation.** `bench-run.mjs` deletes the scratch repository's issues and branches,
  and closes its PRs, before every step.
- **Scenario answers stay hidden.** The replay exports the plugin with `git archive`, leaving
  out the benchmark files the agents under test must not read.
- **New scenario and report.** A fourth scenario, `caller`, targets the review of a changed
  function's existing callers. The report gains a token-type table and per-scenario rates of
  blocking reviews and of reviews that found the scenario's target.
- **`--orchestrate-args`** lets one ref be replayed under two settings.
- **Harder review evals.** The suite now has 21 seeded cases and an `eval-run.mjs` matrix runner.
  Results are in [docs/benchmarks.md](docs/benchmarks.md).

### What changed in 0.8.0

Four defaults changed. Each is a behaviour change for a run that passes no new flag:

- **Effort is explicit.** The implementer, the first review and an escalated re-review pass
  `effort: 'high'`; the fix and the confirming re-review pass `medium`. Nothing inherits the
  session's effort any more, because on Opus 5.5 that default is `medium`. A result's `effort`
  now reads `high`/`medium`, never `inherit`.
- **Agents no longer pin `model: inherit`.** No agent sets `model:` at all, so a
  `CLAUDE_CODE_SUBAGENT_MODEL` you set now applies to them (an explicit `inherit` outranked it
  since Claude Code v2.1.251). The workflow's per-call routing is unchanged.
- **`--small-model sonnet|inherit|haiku`** chooses the model of the small tier (small
  implementations, light reviews, fixes, confirming re-reviews). The default, `sonnet`, is the
  0.7.x behaviour. It is a flag, not a plugin `userConfig` option, because a workflow script
  cannot read plugin options. Useful where `sonnet` resolves to Sonnet 4.5 (Bedrock, Agent
  Platform, Foundry).
- **One security threshold.** `critical` and `high` block; `medium` is a follow-up unless it
  is exploitable in the changed code; audits run at `--audit-level=high`. The implementer and
  the reviewer now apply the same rule, so a medium finding no longer costs a fix cycle.

Also in 0.8.0: the fix runs in the implementer's *Fix mode* on the PR's existing branch;
dispatched agents never stop to ask; the preloaded `code-issue` and `code-review` skills are
about 30–43% shorter, with detail in reference files read on demand; the light review reads
only the files it needs; the `orchestrator` agent points at `/delivery:orchestrate`;
`research`, `ui-vision` and `code-review` carry provisional `maxTurns` ceilings; and `evals/`
holds a small `claude plugin eval` suite for comparing model tiers.

---

## Repository layout

```
.claude-plugin/
  plugin.json          # the plugin manifest (name, version, description, author)
  marketplace.json     # makes this repo a single-plugin marketplace of itself
agents/                # flat files, YAML frontmatter, name == filename stem
skills/<name>/SKILL.md # one directory per skill
workflows/
  orchestrate.js       # each exports `meta` as a PURE literal
  plan-epic.js
scripts/
  verify-plugin.mjs    # stdlib-only structural checks; run it before every PR
  cost-report.mjs      # the report /delivery:cost-report runs
  eval-run.mjs         # opt-in review eval matrix: tiers x scopes x N runs (costs model calls; never in CI)
  eval-tiers.mjs       # tier table over `claude plugin eval` results: recall spread, batch review, confidence
  eval-build.mjs       # generates the eval prompts from workflows/orchestrate.js, plus scaffolds and full copies
  eval-scaffold.mjs    # builds one eval case's fixture repository
  footprint.mjs        # fixed prompt bytes per dispatch, for any git ref
  bench-run.mjs        # opt-in, expensive pipeline replay of a plugin ref on bench/ (never in CI)
  bench-report.mjs     # tokens, findings and behaviour checks from bench-run's results
  fixtures/            # synthetic inputs for the verifier
evals/                 # review eval cases (fixture repo, graders), light scope; full/ holds the full-scope copies
bench/                 # fixture repo, canned issues and a plan-epic topic for bench-run.mjs
docs/                  # installation, usage, configuration, gotchas, customising, benchmarks, templates
```

## Contributing

1. Branch from `main`.
2. Make the change. Keep an agent's `name:` equal to its filename stem, and a workflow's
   `meta` a **pure literal** — no variables, calls or template interpolation.
3. Validate:
   ```bash
   node scripts/verify-plugin.mjs              # structure, frontmatter, meta purity, phase order
   claude plugin validate . --strict           # manifest schema, warnings as errors
   claude --plugin-dir . plugin details delivery   # expect Skills (12), Agents (8)
   ```
4. Keep it project-agnostic. This is the one rule that matters: no project names, no
   organisation names, no domain vocabulary, no toolchain assumptions, and no bare issue
   references, including this repository's own. Plugin text is read in other repositories,
   where `#412` means nothing. If a war story makes the point, keep its *shape* and drop the
   citation.
5. Bump the version (see [Releases](#releases)) and open a PR.

## License

MIT — see [LICENSE](LICENSE).
