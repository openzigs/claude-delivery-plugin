# delivery — a Claude Code plugin

A project-agnostic delivery pipeline for Claude Code: two workflows, seven agents and
nine skills that take a GitHub issue from implementation through **independent review**,
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
execute a line. That is why this plugin is packaged as workflows that dispatch agents: the
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

**Model and effort per phase:**

| Phase | Model | Effort |
|---|---|---|
| Implement | Sonnet with `--small` or `--points N` ≤ 2; otherwise the session model | `high` |
| Review | Sonnet when light; the session model when full | `high` |
| Fix | Sonnet (the session model if Sonnet did the implementing) | `medium` |
| Re-review | Sonnet; escalated to the session model at full scope if the first review was light and still blocked | `medium`, or `high` when escalated |

**Batches.** Space-separated issues are one batch for one implementer — use it for related
issues that touch the same code. Each issue still gets its own branch and PR, and its own
review. Separate batches with `;` and they run **concurrently**, every agent in its own git
worktree. A size hint belongs to the batch it is written in.

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

## What a result contains

`/delivery:orchestrate` returns `{ batches, reviewCompleted, merged: false, suggestedProjectNotes, note }`.
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
| `stillBlocking` | After a re-review: `true` if blocking findings remain, `false` if not; `null` when no re-review ran |

Also present: `reviewScope` (`light` or `full`) with its `reviewRouting` reason, the review,
fix and re-review outputs, and `reviewCompleted: false` with a note when a review never
returned. `/delivery:plan-epic` returns its `research`, its `plan` and
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
| `delivery:e2e-test` | Writes Playwright specs mapped to acceptance criteria | Directly, or by `delivery:code-issue` for UI work |
| `delivery:ui-vision` | Drives a real headed browser through a running app and files what it finds. Writes no tests | Directly ("walk through the settings page") |

### Skills

`code-issue`, `code-review`, `cost-report`, `e2e-test`, `epic-planner`, `repo-scaffold`,
`research-gather`, `resolve-pr-comments`, `ui-vision`.

Each is typed namespaced, as `/delivery:<name>`, to run its procedure in the current session,
and is also loaded by the agents that follow it.

| Skill | What it does | Used |
|---|---|---|
| `/delivery:code-issue` | The implement-an-issue procedure: plan, branch, TDD, security scan, CI, PR | Preloaded by `delivery:code-issue`; type it to run the procedure in your session |
| `/delivery:code-review` | The review procedure: requirements, design, OWASP, quality, performance, tests, publish | Preloaded by `delivery:code-review`; type it as `/delivery:code-review 88` |
| `/delivery:cost-report` | The per-run, per-phase cost report above | Typed only |
| `/delivery:e2e-test` | Acceptance criteria to Playwright specs, Page Object Model, accessible locators | By `delivery:e2e-test`; or typed as `/delivery:e2e-test 412` |
| `/delivery:epic-planner` | Epic and sub-issue structure, Mermaid diagrams, story points, phase order | By `delivery:code-planner` in `/delivery:plan-epic` |
| `/delivery:repo-scaffold` | A new repository from nothing: stack, scaffolding, CI, and the `CLAUDE.md` this pipeline reads | Typed on an empty repository, or by `delivery:code-planner` |
| `/delivery:research-gather` | Collects and converts research material from files, the web and library docs | By `delivery:research` in `/delivery:plan-epic` |
| `/delivery:resolve-pr-comments` | Triages unresolved review threads, fixes the valid ones, replies and resolves them | Typed after a review: `/delivery:resolve-pr-comments 88` |
| `/delivery:ui-vision` | A structured browser walkthrough with screenshots, console capture and bug filing | By `delivery:ui-vision`; or typed with the app running |

The reviewer and the QA agent hold `disallowedTools: Write, Edit` on purpose: removing the
write tools from a reviewer's schema is a stronger guarantee than trusting it not to reach
for them. More in [`docs/usage.md`](docs/usage.md#agents).

**Cost.** Every dispatched agent pays for the project's `CLAUDE.md` before it starts, so the
pipeline keeps the agent count low: no sizing agent, one implementer per batch, and a clean
issue costs two agents. The biggest lever is yours: keep `CLAUDE.md` a small index — see
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

You should see `Skills (9)` and `Agents (7)`.

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
  eval-tiers.mjs       # tier table over `claude plugin eval` results
  fixtures/            # synthetic inputs for the verifier
evals/                 # light-review eval cases (seeded defects + a control) for A/B-ing model tiers
docs/                  # installation, usage, configuration, gotchas, customising, templates
```

## Contributing

1. Branch from `main`.
2. Make the change. Keep an agent's `name:` equal to its filename stem, and a workflow's
   `meta` a **pure literal** — no variables, calls or template interpolation.
3. Validate:
   ```bash
   node scripts/verify-plugin.mjs              # structure, frontmatter, meta purity, phase order
   claude plugin validate . --strict           # manifest schema, warnings as errors
   claude --plugin-dir . plugin details delivery   # expect Skills (9), Agents (7)
   ```
4. Keep it project-agnostic. This is the one rule that matters: no project names, no
   organisation names, no domain vocabulary, no toolchain assumptions, and no bare issue
   references, including this repository's own. Plugin text is read in other repositories,
   where `#412` means nothing. If a war story makes the point, keep its *shape* and drop the
   citation.
5. Bump the version (see [Releases](#releases)) and open a PR.

## License

MIT — see [LICENSE](LICENSE).
