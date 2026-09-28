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

### `/delivery:orchestrate` — an issue to a reviewed PR

```
/delivery:orchestrate <issue number>
/delivery:orchestrate <a description of what you want done>
/delivery:orchestrate                       (uses what you described in conversation)
```

**Phases:** Implement → Review → *(Fix → Re-review, conditionally)*

| Phase | Agent | Notes |
|---|---|---|
| Implement | `delivery:code-issue` | TDD, coverage, branch, PR, CI watch |
| Review | `delivery:code-review` | Independent read of the PR; publishes inline comments, and returns its findings as structured output with a `blocking` flag |
| Fix | `delivery:code-issue` | Only if the review flagged a blocking finding |
| Re-review | `delivery:code-review` | Cycle 2 of a maximum 2 |

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

**It writes no code and opens no pull request.** It ends at filed issues. To take one
forward: `/delivery:orchestrate <that issue number>`.

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

`delivery:orchestrator` is the plugin's example of this — it can dispatch all six of the
others.

### The roster

| Agent | Use it when | Notable properties |
|---|---|---|
| `delivery:orchestrator` | Someone says "work on issue N" without naming agents | `disallowedTools: Write, Edit`. Its whole job is that the review phase happens |
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
