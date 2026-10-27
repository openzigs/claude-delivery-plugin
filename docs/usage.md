# Usage

Three kinds of component, and **only two of them can be invoked by typing**. Getting this
distinction right is most of knowing how to use the plugin.

| Component | How it is invoked | Guaranteed? |
|---|---|---|
| **Workflow** | You type `/delivery:orchestrate 412` | **Yes.** It is a script; the phases are code |
| **Skill** | You type `/delivery:code-review 88`, or an agent calls the `Skill` tool | Yes when typed |
| **Agent** | **Cannot be typed.** Only dispatched — by a workflow, by another agent's `Agent` tool, or by the main model deciding to | Only when a workflow does it |

That last row is the whole reason this plugin exists. There is no `/code-review` syntax that
runs the `code-review` *agent*; asking for one nicely in a `CLAUDE.md` does not create one.
If you want a phase to definitely happen, run the workflow.

---

## Workflows

### `/delivery:orchestrate` — issues to reviewed PRs

```
/delivery:orchestrate <issue number>
/delivery:orchestrate <issue> <issue> <issue>          (one batch: one implementer, one PR per issue)
/delivery:orchestrate <issues> ; <issues>              (independent batches, run concurrently)
/delivery:orchestrate <issue...> --points N | --small  (size hint for that batch's implementation)
/delivery:orchestrate <issue...> --small-model sonnet|inherit|haiku  (the small tier's model, whole run)
/delivery:orchestrate <issue...> --small-effort medium|high          (the small-tier implementer's effort, whole run; unmeasured)
/delivery:orchestrate <issue> <issue> --batch-review   (experimental: one review per batch, whole run)
/delivery:orchestrate <a description of what you want done>
/delivery:orchestrate                                  (uses what you described in conversation)
```

**Phases:** Implement → Review → *(Fix → Re-review, conditionally)* — per PR

| Phase | Agent | Notes |
|---|---|---|
| Implement | `delivery:code-issue` | TDD, coverage, branch, PR, CI watch — for each issue in the batch, in order. Also reports each issue's story points and labels and each PR's diff size as structured output |
| Review | `delivery:code-review` | Independent read of each PR; publishes inline comments, and returns its findings as structured output with a `blocking` flag. **Light** or **full** scope depending on the change's risk (below) |
| Fix | `delivery:code-issue` | Only if the review flagged a blocking finding. Returns structured output: each finding `changed` (with its test), each `declined` (with the reason), and whether the `gates` passed and the fix is pushed |
| Re-review | `delivery:code-review` | Cycle 2 of a maximum 2 |

**Every PR is reviewed, and nothing merges.** A batch shares one implementer, never one
review: each PR gets its own review, its own fix and its own re-review, capped at two
cycles. An issue the implementer did not finish, or that has no PR, is named in the log and
the result reports `reviewCompleted: false`.

**Cheap mode: `--batch-review` (experimental, off by default).** For a batch of two or more
PRs, one `delivery:code-review` dispatch reviews them all, at full scope on the session model
and `high` effort, publishes a separate review on each PR, and returns one structured entry
per PR. Each PR is then routed on its own entry: a PR it blocks gets its own fix and
re-review; a PR it returned nothing for is reported as not reviewed. The trade-off is
independence: one reviewer splits its attention across several changes, so it is likelier to
miss a defect than a review per PR. So the flag is **ignored** — the batch is reviewed per PR,
and the log says why — when any issue in the batch carries a risk label (the same match as
the light-review rule), when any issue's labels are unknown, or when the batch has one PR. The
result records `cheapMode` for the run and `reviewMode` (`batch` or `per-pr`) with
`reviewModeWhy` per batch; the batch review's output tokens are `outputTokens.batchReview` on
the batch, and each PR it covered has `reviewedInBatch: true`. The cost-report marks the run as
cheap mode and shows the batch review as its own row. It stays experimental: the review eval
compares it with per-PR review, and at N=3 its recall matched per-PR review on haiku and the
session model but not on sonnet, which twice approved a defect the per-PR review caught
([benchmarks](benchmarks.md#results-at-92-claude-code-21311-n3) has the numbers and the
criterion for dropping "experimental").

**How each step picks its model.** There is no separate sizing agent; the implementer reads
the issue anyway and reports what the later steps route on.

- *Implement* runs on Sonnet only if you said the batch is small (`--small`, or
  `--points N` with N ≤ 2). With no hint it runs on the session model: an unknown size is
  never a reason to use a cheaper model.
- *Review* is **light, on Sonnet** only when the issue's own `Story Points` line is ≤ 2,
  none of its labels look risky (`security`, `auth`, `migration`, `breaking`, `payment`,
  `billing`, `privacy`, `infra`, `data-loss`), **and** the PR changes at most 5 files and 150
  lines (additions + deletions). A light review covers requirements, correctness, tests and
  security of the changed lines, reads only the changed files it needs, and skips the
  design, performance and documentation passes. Anything else — or anything unknown — gets the full review on the session model.
- *Fix* runs on Sonnet, or on the session model if Sonnet did the implementing.
- *Re-review* runs on Sonnet, or on the session model, at full scope, if the first review
  was a light one that still found something blocking.

**Effort per step.** The implementer and the first review run at `high` effort, passed
explicitly rather than inherited: Claude Code's default effort on Opus 5.5 is `medium`
([model configuration](https://code.claude.com/docs/en/model-config)), so inheriting would
usually mean medium. The fix and the re-review run at `medium`, except a re-review escalated
from a light review: that is the change's first full-scope review, so it runs at `high` too.
Medium effort is known to lose real findings for quality and performance reviewers, which is
why the first review never drops. `--small-effort medium` drops only the implementer of a
small-tier batch (`--small`, or `--points N` ≤ 2) to `medium`; it is unmeasured, and the
default stays `high` until a replay compares the two ([customising](customising.md#the-small-tiers-effort---small-effort)).

| Step | Effort |
|---|---|
| Implement | `high`; a small-tier implementer follows `--small-effort` (default `high`) |
| Review (light or full) | `high` |
| Fix | `medium` |
| Re-review | `medium`; `high` when escalated from a light review |

Every decision is logged with its reason, and each PR's result records the scope and the
models used. The thresholds are constants at the top of `workflows/orchestrate.js` — see
[customising](customising.md#choosing-models-in-the-script-not-in-frontmatter).

<a name="what-the-result-measures"></a>
**What the result measures**, so the effect of a routing or effort change can be judged
rather than assumed:

| Field | Where | What it holds |
|---|---|---|
| `models` | each PR | The model of each phase that ran (`session model` when inherited) |
| `effort` | each PR | The effort passed to each phase that ran: `implement`, `review`, and `fix` / `rereview` when they ran. Always `high` or `medium`; results from before 0.8.0 show `inherit` where no effort was set |
| `implementEffort`, `implementEffortWhy` | each batch | The effort the batch's implementer ran at, and why: the small tier with or without `--small-effort`, or not the small tier. Recorded even when no PR was opened. The cost-report shows both on the Implement row |
| `outputTokens` | each PR: `review`, `fix`, `rereview`; each batch: `implement` | Output tokens per phase, as the difference in `budget.spent()` around that agent call. `null` when the runtime provides no `budget` |
| `findingCounts` | each PR | `{ review, rereview }`, each a count per severity (`critical`, `high`, `medium`, `low`, `nit`) from the review's structured output, after low-confidence findings are dropped. `rereview` is `null` when no re-review ran |
| `suppressedFindings` | each PR | How many non-blocking findings the review and re-review rated below confidence 50 and the workflow dropped before the fix pass. A blocking finding is never dropped, whatever its confidence. The cost-report shows it on the PR's Review row and in its totals |

**Suggested project notes.** The run's result also carries `suggestedProjectNotes`: every
`durableFinding` a review or re-review returned — a lesson a future reviewer could not derive
from the code, such as a defect class that recurs in this project — collected across all PRs
in the run and deduplicated (ignoring case and whitespace). It is a list of strings, and an
empty list when no review returned one. It is a **suggestion only**: nothing in the workflow
writes it anywhere, and no dispatched prompt tells an agent to edit `CLAUDE.md`, `AGENTS.md` or
`.claude/delivery.md` (the verifier checks the common phrasings, not every possible one). Each note is capped at 500
characters. The notes come from reviewers reading an untrusted PR, so read them critically before
copying what you want to keep into your project's notes file or `CLAUDE.md` yourself.

`budget.spent()` counts the whole turn, so when batches run concurrently a phase's delta
also includes what the other batches spent in the same window. Read token figures from a
single-batch run when you are comparing them.

**Batches and concurrency.** Space-separated issues are one batch, worked in order by one
implementer — a good fit for related issues that touch the same code. Each still gets its
own branch from the default branch and its own PR (or, if it genuinely depends on an earlier
issue in the batch, a branch stacked on that one, said in the PR body). Separate batches
with `;` and they run **concurrently**, and then every agent in every batch runs in its own
git worktree, so no two of them ever share a checkout. A single batch runs in your current
checkout as before. Size hints belong to the batch they are written in:
`/delivery:orchestrate 412 413 --small ; 500 501` hints only the first batch.

**It never merges.** Merging is your decision, and an automated merge on a branch nobody
looked at is unreviewable after the fact.

**Worked example — a bare issue number:**

```
/delivery:orchestrate 412
```

The argument is parsed as an issue reference. The implementer is told to open a PR with
`Closes #412`.

**Worked example — a description with no issue yet:**

```
/delivery:orchestrate make the audit filter honour a date range
```

The argument is *not* a number, so it is treated as a description and the implementer is
instructed to **file the issue first**, then open a PR that closes it — work without an issue
leaves no record of why it was done. (This branch exists because naively interpolating
`issue #${args}` produces `issue #make the audit filter…`, which reads like a real reference
and is not one.)

**Worked example — related issues, then two lanes at once:**

```
/delivery:orchestrate 412 413 415
/delivery:orchestrate 412 413 ; 500 501
```

The first is one implementer working #412, #413 and #415 in turn, three PRs and three
reviews. The second runs two such lanes concurrently, each in its own worktrees. A
description is never split into batches, even if it contains a `;`.

**Worked example — the `#` prefix:**

```
/delivery:orchestrate #412
```

Identical to `412`. The `#` is stripped.

**Why the fix decision is structured output and not a regex.** Reviewers phrase blockers
several ways — "must fix before merge", "blocking", "I would not ship this". A regex that
missed one would silently skip the fix phase, which is precisely the class of failure this
workflow exists to prevent. So the review agent is given a JSON schema and must commit to a
`blocking` boolean, and a per-finding `blocking` flag, at the tool-call layer. The fix runs
if *either* says blocking. A review that never returns stops the run as unreviewed rather
than being treated as clean.

---

### `/delivery:plan-epic` — a topic to filed issues

```
/delivery:plan-epic <topic>
/delivery:plan-epic <path to a directory of documents>
/delivery:plan-epic <URL>
/delivery:plan-epic                          (uses what you described in conversation)
```

**Phases:** Research → Plan

| Phase | Agent | Notes |
|---|---|---|
| Research | `delivery:research` | Local files, web, library docs, **and this repository** — including the open backlog, so the plan does not duplicate filed work |
| Plan | `delivery:code-planner` | Runs `gh label list` first so it does not invent parallel labels, then files the epic and sub-issues with Mermaid diagrams, acceptance criteria, story points, phase order |

Both stages inherit the session's model and effort. The result's `outputTokens`
(`{ research, plan }`) holds the output tokens of each, as `budget.spent()` deltas, or
`null` when the runtime provides no `budget`.

**It writes no code and opens no pull request.** It ends at filed issues. To take one
forward: `/delivery:orchestrate <that issue number>`, or several related sub-issues as one
batch: `/delivery:orchestrate <n> <n> <n>`.

**Worked examples:**

```
/delivery:plan-epic add SSO with SAML and SCIM provisioning
/delivery:plan-epic ~/Documents/product-requirements/q3-retention
/delivery:plan-epic https://example.com/rfc/audit-retention
```

The name is `plan-epic` rather than `plan` deliberately: Claude Code has a plan mode of its
own, and a slash command that collides with a built-in fails by doing nothing — the exact
failure class this plugin is built to remove.

---

## Agents

You cannot type an agent's name. You get one of three routes.

### Route 1 — a workflow dispatches it (deterministic)

The workflows pin the agent explicitly:

```js
await agent(prompt, { agentType: 'delivery:code-issue', phase: 'Implement' })
```

This is the only route with a guarantee attached. Prefer it.

### Route 2 — the main model chooses it (probabilistic)

Say what you want and let the model match your request against each agent's `description`:

> "Review PR 88 against the requirements in issue 412."
>
> "Walk through the settings page in a browser and tell me what's broken."

This works, and it is the normal way to use a single agent for a one-off. But it is a
*request*: the model may do the work itself instead, and nothing will tell you it did. If the
outcome matters, check which agent ran.

### Route 3 — one agent dispatches another (declared in `tools:`)

An agent can only dispatch agents named in its own `tools:` field, namespaced:

```yaml
tools: Read, Bash, Agent(delivery:code-issue, delivery:code-review)
```

`delivery:orchestrator` (which points you at `/delivery:orchestrate` first) is the plugin's
example of this — it can dispatch `delivery:code-issue` and `delivery:code-review`.

### The roster

| Agent | Use it when | Notable properties |
|---|---|---|
| `delivery:orchestrator` | Someone says "work on issue N" without naming agents | Points at `/delivery:orchestrate`; runs the same four phases only if the command cannot be used. `disallowedTools: Write, Edit` |
| `delivery:code-issue` | One issue, end to end | Writes code. Can dispatch `delivery:e2e-test` |
| `delivery:code-review` | Before merging anything | No write tools, on purpose. Publishes a `Recommendation:`, never an APPROVE |
| `delivery:code-planner` | A feature with no issue yet | Files epics and sub-issues; writes no product code |
| `delivery:research` | Docs, URLs, or an unfamiliar standard govern the work | Read-only. Its output feeds planning |
| `delivery:e2e-test` | There is user-visible behaviour to lock down | Playwright specs; MCP optional, CLI fallback |
| `delivery:ui-vision` | "Walk through the UI", "reproduce this visually" | **Requires the Playwright MCP server.** Writes no tests |

Two design decisions worth understanding:

- **`code-review` and `ui-vision` have no write tools.** For a reviewer, editing the code
  under review is the near-at-hand move when a test fails; taking `Write` and `Edit` out of
  the schema is stronger than instructing it not to. For a QA agent, the equivalent
  temptation is patching the app to make the walkthrough pass.
- **Neither is a sandbox.** Both still hold `Bash`. The guarantee is about the *easy* path,
  not about containment.

---

## Skills

Skills are procedures. Type one to run its procedure in the current session, or let an agent
that has `Skill` in its `tools:` invoke it.

| Skill | What it does |
|---|---|
| `/delivery:code-issue` | The full implement-an-issue procedure: plan, branch, TDD loop, security scan, CI, PR |
| `/delivery:code-review` | The full review procedure: requirements, design, OWASP, quality, performance, tests, docs, publish |
| `/delivery:cost-report` | Per-run, per-phase cost table from saved workflow results; read-only. See [reading the cost of a run](#reading-the-cost-of-a-run) |
| `/delivery:e2e-test` | Map acceptance criteria to Playwright specs, Page Object Model, accessible locators |
| `/delivery:epic-planner` | Epic and sub-issue structure, Mermaid diagrams, story points, phase ordering |
| `/delivery:repo-scaffold` | New repository from nothing: stack selection, scaffolding, CI, and the `CLAUDE.md` this pipeline reads |
| `/delivery:research-gather` | Collect and convert research material from local files, the web and library docs |
| `/delivery:resolve-pr-comments` | Fetch unresolved review threads, triage, fix, reply, and resolve them via the GraphQL API |
| `/delivery:ui-vision` | Structured browser walkthrough with screenshots, console capture and bug filing |

**Worked examples:**

```
/delivery:code-review 88
/delivery:resolve-pr-comments 88
/delivery:repo-scaffold my-new-service
/delivery:e2e-test 412
```

### Reading the cost of a run

`/delivery:cost-report` turns saved workflow results into a per-run, per-phase table of the
fields described in [What the result measures](#what-the-result-measures): output tokens,
effort, model and finding counts, then totals and a per-phase trend across runs.

It reads only the paths you give it, unless you pass `--discover` (below). When a
`/delivery:orchestrate` or `/delivery:plan-epic` run finishes, Claude Code writes the run's
task output to a `<task-id>.output` file; the path is printed in the workflow's completion
notice. You can point the report straight at that file:
it is a wrapper whose `result` holds the result object (or a JSON string of it), and the report
reads the result inside. Alternatively, copy the result object into a file of its own. Either
way, pass the files or their directory:

```
/delivery:cost-report <path from the completion notice>/tasks/<task-id>.output
/delivery:cost-report runs/2026-10-22-orchestrate-14.json
/delivery:cost-report runs/
/delivery:cost-report runs/ --include-concurrent
/delivery:cost-report --discover --last 5
```

A directory contributes every `*.json` and `*.output` directly inside it, sorted by file name.
Runs are reported, and the trend read, in start-time order when every run records a
`startTime` or `timestamp`; otherwise in the order given, and the trend header says which.
A wrapped run is named by the wrapper's own `runId`, `run_id`, `taskId` or `task_id` when it
has one made only of letters, digits, `_`, `.`, `:` and `-`, and no other input shares it.
Any other run is named by its path relative to the deepest directory holding every input, so
`a/result.json` and `b/result.json` stay two runs. In a directory, a file that is not JSON or
not a delivery result (including a wrapper whose `workflowName` is another workflow) is
counted on one `skipped` line; `--verbose` lists them. A file you name that is not a result
is reported as `unrecognised` on its own line. With no arguments the skill prints how to save
a result and stops; it does not search for results.

`--discover` is the one search, and it runs only when you pass it. It reports the runs Claude
Code saved for the current directory's project, oldest first:
`<config>/projects/<project>/<session>/workflows/wf_<run-id>.json`, where `<config>` is
`$CLAUDE_CONFIG_DIR` or `~/.claude` and `<project>` is the directory's path with every
character other than a letter or digit replaced by `-`. Only files with that name pattern are
opened; session transcripts beside them are not. Runs of other workflows and unparseable files
are counted on the `skipped` line. A run with no start time is placed first (the oldest end),
and the trend header says so, so `--last N` always keeps the newest N timed runs. `--since DATE`
keeps those started on or after DATE, and counts a run it dropped for having no start time on
the `skipped` line (`without a start time`). When nothing is found it prints
`no runs found under <dir>` rather than an empty table; when runs were found but `--since`
excluded them all, it prints `no runs match --since <date> (N found under <dir>)`. That layout is undocumented (checked on Claude Code 2.1.308) and may change
between versions.

The skill runs `scripts/cost-report.mjs`,
which does every sum, and shows only the metrics: never a result's `research`, `plan`,
`review` or `implemented` text.

Two caveats travel with every report:

- **Concurrent runs overlap.** `budget.spent()` counts the whole turn, so when batches run
  concurrently a phase's delta also includes what the other batches spent. Such a run is
  marked `CONCURRENT` and left out of the trend unless you pass `--include-concurrent`.
  Compare token figures across single-batch runs.
- **Severity counts are a proxy.** A fall in findings after a routing or effort change does
  not show whether findings were lost; read the reviews themselves before concluding that a
  cheaper review is as good.

`not measured` means the runtime gave no `budget` for that phase, which is not zero; `n/a`
means the workflow never records that field for that phase.

### Two skills with no agent of their own

`repo-scaffold` and `resolve-pr-comments` are procedures rather than roles:

- **`repo-scaffold`** is run by `delivery:code-planner`, or typed directly. Use it on an
  empty repository — it selects a stack, scaffolds it, sets up CI, and emits a root
  `CLAUDE.md` stating the project's real commands. That last part matters: everything else
  in this plugin reads that file, so scaffolding a repo with it means the pipeline works in
  that repo from day one.
- **`resolve-pr-comments`** is the natural follow-on to a review. It reads unresolved
  threads, triages each into valid / needs-clarification / already-resolved / disagree,
  fixes the valid ones, replies, and resolves the threads. A comment it declines gets a
  stated reason rather than silence.

---

## A typical end-to-end session

```bash
cd ~/work/my-project
claude
```

```
> /delivery:plan-epic add audit-log retention with a configurable window

  ... Research → Plan ...
  Filed epic #530 with sub-issues #531, #532, #533.

> /delivery:orchestrate 531

  ... Implement → Review ...
  PR #540 opened. Review found 1 blocking finding.
  ... Fix → Re-review ...
  Re-review: no blocking findings remain. Nothing was merged.

> /delivery:resolve-pr-comments 540

  ... 3 threads triaged, 2 fixed and resolved, 1 replied and left open ...
```

Then you look at PR #540 and decide whether to merge it. The pipeline deliberately stops
one step short of that.
