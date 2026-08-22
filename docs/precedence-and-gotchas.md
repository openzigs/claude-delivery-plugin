# Precedence and gotchas

Everything on this page **fails silently**. Nothing here produces an error message; things
simply do not happen, and the session carries on producing plausible output. That is why the
page exists — and why "it seems to be working" is not evidence for any of it.

---

## 1. A project's `.claude/agents/` silently overrides plugin agents

If your repository has `.claude/agents/code-review.md`, **that file wins** over the plugin's
`code-review` agent. No warning, no note, no indication in the transcript.

Rough precedence, most specific first:

| Source | Location | Beats |
|---|---|---|
| Project agents | `<repo>/.claude/agents/<name>.md` | Everything below |
| User agents | `~/.claude/agents/<name>.md` | Plugin agents |
| Plugin agents | `<plugin>/agents/<name>.md` | — |

**When this is what you want:** overriding one agent for one project is the intended way to
customise. See [customising](customising.md#override-a-single-agent-for-one-project).

**When it bites:** you install the plugin into a repository that already had its own
`code-issue.md` from a previous experiment, get that old one instead, and spend an afternoon
wondering why your changes to the plugin have no effect.

**How to check:**

```bash
ls .claude/agents/ ~/.claude/agents/ 2>/dev/null
```

Any filename there that matches a plugin agent name is shadowing it. Rename yours, or delete
it.

---

## 2. Workflows cannot be symlinked

**Claude Code refuses to write through a symlink**, so a workflow file that is a symlink
into another directory does not behave like the file it points at. The failure does not name
the symlink, which is what makes it expensive: you get behaviour that looks like a stale or
corrupted workflow.

Skills are different — a skill directory can be a symlink, and some repositories deliberately
keep one canonical `SKILL.md` and link it from `.claude/skills/`. Do not generalise from that
to workflows.

**Do this instead:**

- **Copy** the workflow file rather than linking it, or
- point Claude Code at the real directory with `--plugin-dir /real/path`, or
- install the plugin properly, so the runtime manages its own copy.

---

## 3. An agent's `name` must match its filename

Three requirements, all of which fail by the agent simply not existing:

1. `name:` is **required**. So is `description:`.
2. `name` must be **lowercase letters, digits and hyphens only**.
3. `name` must equal the **filename stem** — `code-review.md` must declare
   `name: code-review`.

```yaml
---
name: code-review        # matches code-review.md
description: "..."       # required — and it is what the model reads when choosing
---
```

Get any of these wrong and the agent does not load. Nothing says so. The only symptom is that
a dispatch you expected never happens, or `claude plugin details` shows `Agents (6)` where you
expected 7.

**How to check:** count them.

```bash
claude --plugin-dir /path/to/claude-delivery-plugin plugin details delivery
```

If the count is short, compare each file's `name:` against its filename.

---

## 4. Omitting `Agent` from an orchestrator's `tools` delegates nothing

This one is worth the most attention, because the output looks *right*.

An agent whose `tools:` list does not include `Agent` cannot dispatch anything. It does not
error. It runs, reasons about the pipeline, produces a report describing phases that
"completed" — and no subagent was ever created.

```yaml
# Broken — no delegation, no error:
tools: Read, Bash, Skill

# Correct — and namespaced:
tools: Read, Bash, Skill, Agent(delivery:code-issue, delivery:code-review)
```

The same trap applies to `Skill`: an agent instructed to invoke `/delivery:code-review` but
without `Skill` in `tools:` will improvise a review from memory instead of following the
procedure.

**How to check:** if a dispatch was supposed to happen and you saw no subagent activity, read
the agent's frontmatter before debugging its prompt.

---

## 5. Agent-to-agent references must be namespaced

Inside a plugin, `Agent(code-issue)` does not resolve. It must be
`Agent(delivery:code-issue)`. The same applies to `Workflow(delivery:orchestrate)` and to the
`agentType` option a workflow passes:

```js
await agent(prompt, { agentType: 'delivery:code-issue' })
```

An unnamespaced reference fails to resolve, and — you will have guessed — does not say so.

---

## 6. A workflow's `meta` must be a pure literal

The runtime reads `meta` **without executing the module**, so it must be a literal object:
no variables, no function calls, no template interpolation, no concatenation.

```js
// Rejected:
const NAME = 'orchestrate'
export const meta = { name: NAME, description: `Run ${NAME}` }

// Accepted:
export const meta = {
  name: 'orchestrate',
  description: 'Run a GitHub issue through implement -> review -> fix -> re-review',
  whenToUse: 'Type /delivery:orchestrate <issue number> to ...',
  phases: [{ title: 'Implement', detail: '...' }],
}
```

Keep `whenToUse` as one long single-quoted string rather than several joined with `+`. It is
less pretty and it is unambiguously a literal.

---

## 7. `claude plugin details` does not list workflows

An empty workflow listing is not a symptom. The command reports skills, agents, hooks, MCP
servers and LSP servers — **not workflows** — and this is true of Anthropic's own plugins
too.

Confirm workflows a different way: type `/` interactively, or

```bash
claude --plugin-dir /path/to/claude-delivery-plugin \
  -p "Without using any tools, list every slash command available to you that starts with 'delivery'."
```

---

## 8. `--plugin-dir` does not hot-reload

The directory is resolved at session start. Editing an agent or a workflow mid-session has no
effect on the running session, and the session will keep behaving like the old version. Restart
after every change while developing.

Related: **`claude --bare` explicitly skips `--plugin-dir`**, along with hooks, MCP servers and
custom commands. If a plugin is not loading and you cannot see why, check whether `--bare` is
coming from an alias or a wrapper.

---

## 9. `claude plugin update` needs a restart

`update` fetches the new version but the running session keeps the old one. The command says
so; it is easy to miss.

---

## 10. A skill in the wrong place is undiscoverable

Claude Code discovers skills under `skills/<name>/SKILL.md` — a **directory per skill**, each
containing a file named exactly `SKILL.md`. A skill placed at `skills/<name>.md` does not load,
and an undiscovered skill is indistinguishable from one the model chose not to use.

The same shape applies in reverse for agents and workflows, which are **flat files**:
`agents/<name>.md`, `workflows/<name>.js`. Directories there do not load.

---

## 11. `name` collisions across plugins

Two plugins can both ship an agent called `code-review`. Namespacing resolves it for explicit
references (`delivery:code-review`), but when the *main model* chooses an agent by reading
descriptions, two similar descriptions make the choice arbitrary.

If you run more than one delivery-style plugin, either disable one
(`claude plugin disable <name>`) or make the descriptions sharply distinct. A description is
not documentation — it is the dispatch mechanism.

---

## The meta-gotcha

All of the above are instances of one thing:

> **In this system, the failure mode is silence.**

An agent that did not load, a phase that did not run, a skill that was not discovered and a
delegation that never happened all look identical from the outside — like a session that
completed and reported success. That is the entire reason this plugin packages its pipeline as
workflows: a script that does not run a line is a bug you can find, whereas a model that did
not choose to dispatch an agent leaves nothing behind to find.
