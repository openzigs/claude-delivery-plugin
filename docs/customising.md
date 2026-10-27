# Customising

Four levels, cheapest first. Try them in this order — most of what people fork an agent for
is achievable with a file in their own repository.

| You want to | Do this | Affects |
|---|---|---|
| Change what agents know about your project | Write `CLAUDE.md` / `.claude/delivery.md` | One project, no plugin changes |
| Change one agent's behaviour in one project | Drop a file in `.claude/agents/` | One project |
| Change an agent everywhere for yourself | Drop a file in `~/.claude/agents/` | All your projects |
| Change the plugin | Fork it | Everyone using your fork |

---

## Level 0 — supply constraints, do not fork

Before editing an agent, check whether the thing you want is a *project fact* rather than a
*behaviour change*. Commands, coverage floors, protected paths, review emphasis, known traps —
all of that belongs in `CLAUDE.md` or `.claude/delivery.md`, and the agents already read both.

See [per-project-configuration](per-project-configuration.md). This is the intended
extension point and it costs nothing.

---

## Override a single agent for one project

Create `.claude/agents/<name>.md` in your repository, using **the same name** as the plugin
agent you want to replace. Project agents beat plugin agents, silently.

```bash
mkdir -p .claude/agents
cp /path/to/claude-delivery-plugin/agents/code-review.md .claude/agents/code-review.md
$EDITOR .claude/agents/code-review.md
```

Three things to keep when you edit it:

1. **`name:` must still be `code-review`** and must still match the filename. It is what the
   workflows' `agentType: 'delivery:code-review'` resolves against.
2. **Keep the `description` sharp.** For anything the main model dispatches by choice, the
   description *is* the dispatch mechanism.
3. **Do not add write tools to the reviewer** unless you mean to. `disallowedTools: Write,
   Edit` is load-bearing: it makes "just fix the code under review" stop being the
   near-at-hand move.

**Remember this file exists.** A forgotten project override is the single most common cause
of "my plugin changes are not taking effect" — see
[precedence-and-gotchas](precedence-and-gotchas.md#1-a-projects-claudeagents-silently-overrides-plugin-agents).

To go back to the plugin's version, delete your file. There is no "disable override" flag.

---

## Fork an agent into your own plugin

If you want changes across projects and across a team, fork the plugin rather than copying
files into every repository.

```bash
gh repo fork openzigs/claude-delivery-plugin --clone
cd claude-delivery-plugin
```

Then edit, and **change the plugin's name** in `.claude-plugin/plugin.json` if you intend to
run it alongside the original — otherwise two plugins both called `delivery` will collide in
ways that are annoying to diagnose:

```json
{ "name": "acme-delivery", "version": "0.1.0", "...": "..." }
```

Changing the plugin name changes every namespaced reference, so update:

- every `Agent(delivery:...)` in `agents/*.md` → `Agent(acme-delivery:...)`
- every `agentType: 'delivery:...'` in `workflows/*.js`
- every `skills: delivery:...` in `agents/*.md` frontmatter. Keep it namespaced: a bare
  name is ambiguous when another skill shares it, as the built-in `code-review` does
- every `/delivery:<skill>` mention in agents, skills and docs

```bash
grep -rn 'delivery:' agents/ workflows/ skills/ | wc -l   # know what you are changing
```

Validate before you use it:

```bash
claude plugin validate . --strict
claude --plugin-dir . plugin details acme-delivery
```

---

## Add a workflow

A workflow is a flat `.js` file in `workflows/`. Two hard requirements and one strong
recommendation.

### 1. `meta` must be a pure literal

The runtime parses `meta` **without executing the module**. No variables, no calls, no
template interpolation, no string concatenation.

```js
export const meta = {
  name: 'ship',                                  // must equal the filename stem
  description: 'One-line summary shown in the command list',
  whenToUse: 'Type /acme-delivery:ship <target> to ... Be specific: this is what tells a reader when to reach for it.',
  phases: [
    { title: 'Build', detail: 'what happens here' },
    { title: 'Verify', detail: 'what happens here' },
  ],
}
```

### 2. The body gets `args`, `agent`, `phase`, `log` and `parallel`

They are provided by the runtime; do not import or declare them. `parallel(thunks)` runs
several `() => agent(...)` chains concurrently and resolves to their results, with `null`
for any that threw.

```js
const target = (args && String(args).trim()) || ''
if (!target) log('Usage: /acme-delivery:ship <target>')

phase('Build')
const built = await agent(
  `Build ${target}. Read CLAUDE.md first and obey it exactly.`,
  { label: 'build', phase: 'Build', agentType: 'acme-delivery:code-issue' },
)

phase('Verify')
const checked = await agent(
  `Verify this build.\n\n${built}`,
  { label: 'verify', phase: 'Verify', agentType: 'acme-delivery:code-review' },
)

return { target, built, checked, merged: false }
```

Options worth knowing on `agent()`:

| Option | Effect |
|---|---|
| `agentType` | **Pin which agent runs.** Namespaced. Omit it and the runtime picks a default agent |
| `label` | Identifies the dispatch in logs and in your own control flow |
| `phase` | Groups the dispatch under a phase in the UI |
| `model` | `'sonnet'`, `'haiku'`, `'opus'`. Omit it to inherit the session model |
| `effort` | `'low'` for cheap mechanical calls |
| `schema` | A JSON Schema; the agent must return a validated object. Use it wherever script control flow branches on an agent's answer |
| `isolation` | `'worktree'` runs the agent in a fresh git worktree. Use it for agents that change files **concurrently** — two agents in one checkout switch branches under each other. Not free (setup time and disk per agent), so not for sequential work |

### Choosing models: in the script, not in frontmatter

Every agent in this plugin is `model: inherit`. Any tiering is done by the workflow, per
`agent()` call, so it applies only to that pipeline, is decided by code and shows in the
run's log. A `model:` pin in an agent's frontmatter applies however the agent is reached,
and the caller cannot see it. That is how an Opus-driven planning run once did its whole
research phase on Sonnet.

What `/delivery:orchestrate` does today. The cost driver it is built around: every dispatched
agent starts by paying for the repository's `CLAUDE.md`, so on a repository with a large one,
the **number** of agents per issue and the tier each runs on dominate the bill.

| Step | Model | Why |
|---|---|---|
| Implement | `sonnet` if the caller hinted `--small` or `--points N` (N ≤ 2), otherwise the session model | No sizing agent: nothing has read the issue yet, and an unknown size is never a reason to use a cheaper model. One implementer works a whole batch |
| Review | **Light**, on `sonnet`, if the issue's own `Story Points` ≤ 2 **and** no label matches `RISKY_LABEL` **and** the PR is ≤ 5 files and ≤ 150 changed lines. Otherwise **full**, on the session model | Routed on facts the implementer reported from `gh` (structured output), never on the hint. Anything unknown → full |
| Fix | `sonnet`, or the session model if sonnet did the implementing | A sonnet implementation that failed review moves up to the stronger model rather than getting another try on sonnet |
| Re-review | `sonnet`; the session model, at full scope, if the first review was light | A light review that still blocked means the change was misjudged as low-risk, so cycle 2 is its first full-scope look |

Effort is chosen the same way, per call in the script and never in agent frontmatter. The
implementer and the first review pass `effort: 'high'`; the fix and the re-review pass
`effort: 'medium'`; a re-review escalated from a light review passes `high`, because it is
that change's first full-scope review. Nothing inherits the session's effort: on Opus 5.5
Claude Code's default is `medium` ([model configuration](https://code.claude.com/docs/en/model-config)),
so inheriting would usually mean the medium the first review must not drop to. Each PR's
result reports the effort, output tokens and finding counts per phase ([usage](usage.md)),
so a change to these choices can be measured.

A light review runs the `code-review` skill's requirements, security (changed lines),
correctness and test steps, and skips design, performance and documentation (which live in
`skills/code-review/FULL_REVIEW_STEPS.md`, read only by a full review). It reads the diff plus
only the changed files it needs, where a full review reads every changed file in full. It is told to
widen to the full skill if the diff touches auth, secrets, payments, migrations or anything
destructive. Lines are GitHub's additions + deletions, so a lockfile or a generated file
counts towards the limit — that errs towards the full review, which is the direction to err.

Each PR's result records `reviewScope`, `reviewRouting` and `models`; every routing decision
is logged with its reason. To change the policy, edit the constants at the top of
`workflows/orchestrate.js` (`SMALL_POINTS`, `RISKY_LABEL`, `LIGHT_REVIEW_MAX_FILES`,
`LIGHT_REVIEW_MAX_LINES`, `fixModel`, `rereviewModel`). `scripts/verify-plugin.mjs` checks
every routing case.

Concurrent batches (`412 413 ; 500 501`) pass `isolation: 'worktree'` on **every** agent in
every batch, and tell each agent how to share branches across worktrees (a branch can be
checked out in only one at a time). A single batch runs in the caller's checkout with no
isolation.

`/delivery:plan-epic` is not tiered. Its research output is what every sub-issue gets
written from, so both of its phases inherit.

### 3. Do not re-carry `CLAUDE.md`

Every workflow subagent starts with the repository's `CLAUDE.md` already in context, so do
not read it and paste it into prompts — that pays for it again on every dispatch. Name only
what is not auto-loaded: `.claude/delivery.md`, and `AGENTS.md` where a repository uses it
instead. A subagent does start with none of *your conversation*, so pass earlier phases'
output forward explicitly.

### Testing a workflow without spending tokens

The body is plain JavaScript with injected names, so you can execute it against stubs:

```js
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const body = src.replace(/export const meta = \{[\s\S]*?\n\}\n/, '')

const phases = []
const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', body)
await fn(
  '412',
  async (prompt, opts = {}) => `[stub ${opts.label}]`,
  (title) => phases.push(title),
  () => {},
  (thunks) => Promise.all(thunks.map((t) => t().catch(() => null))),
)
console.log(phases)   // assert the order, including conditional branches
```

Drive the stubbed `agent` to return each answer a real one might — for a review with a
schema, return `blocking: true` on one run, `blocking: false` on another, and `null` for an
agent that died — and assert that both branches produce the
phase sequence you intended. This plugin's own conditional fix/re-review path is tested
exactly this way, in [`scripts/verify-plugin.mjs`](../scripts/verify-plugin.mjs). Run it:

```bash
node scripts/verify-plugin.mjs
```

It also checks agent frontmatter, `name`-to-filename matching, namespaced `Agent(...)`
references, that each `skills:` preload is namespaced and names a real skill (and that
code-issue and code-review declare theirs), skill directory layout, and `meta` purity — every one of which fails silently at
runtime. Stdlib only, no dependencies, no tokens.

---

## Add a skill

A directory with a `SKILL.md` in it. Not a flat file — `skills/<name>.md` is silently
undiscoverable.

```
skills/
  my-procedure/
    SKILL.md              # required, exactly this name
    TEMPLATE.md           # optional companions are fine
```

```markdown
---
name: my-procedure
description: What it does and, critically, WHEN to reach for it. Trigger-rich.
argument-hint: "[target] — what the argument means"
---

# My Procedure
...
```

`name` must equal the directory name. The `description` is what decides whether the skill is
ever chosen, so write it for a model deciding under uncertainty, not as a title.

---

## Keeping a fork project-agnostic

If you are contributing back, this is the one rule that matters. Before opening a PR:

```bash
grep -rniE '<your org>|<your project>|<your domain terms>|#[0-9]{2,3}\b' . --exclude-dir=.git
```

Keep transferable lessons; drop the citations. "A test that cannot fail is not a test —
verify by mutating the implementation and watching it go red" travels anywhere. A trailing
"(this was issue #NNN, the map filter)" travels nowhere — and worse, it reads as
authoritative to an agent that has no way to look it up.
