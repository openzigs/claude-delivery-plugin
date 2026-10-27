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

## 3. An agent is named by its `name`, not its filename

A plugin agent's scoped name is `<plugin>:<name>`, and `<name>` comes **from the frontmatter
`name` field, or from the file name when that field is missing** (or longer than 256
characters). An agent whose frontmatter does not parse still loads, named after its file, with
every field ignored and the description `Agent from <plugin> plugin`. Source:
[plugin components, "Agents"](https://code.claude.com/docs/en/plugins/components), checked
against Claude Code v2.1.311.

So a mismatch no longer stops the agent loading — it **renames** it, which is quieter:

```yaml
# agents/code-review.md
---
name: reviewer           # loads as delivery:reviewer, not delivery:code-review
description: "..."
---
```

Every `agentType: 'delivery:code-review'` in a workflow and every `Agent(delivery:code-review)`
allowlist entry now points at nothing, and the dispatch that should have happened does not.
`scripts/verify-plugin.mjs` keeps each `name` equal to its filename stem, lowercase and
hyphenated, so a reference written from the filename stays right.

**How to check:** `claude plugin validate .` reports a file whose frontmatter does not parse;
`claude --plugin-dir /path/to/claude-delivery-plugin plugin details delivery` lists the agent
names that actually loaded — compare them against the filenames.

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

An empty workflow listing is not a symptom. The command's component inventory is "the
plugin's skills, agents, hooks, MCP servers, and LSP servers" — **not workflows** — and this
is true of Anthropic's own plugins too. Source:
[plugin commands reference, "plugin details"](https://code.claude.com/docs/en/plugins/cli-reference),
confirmed by running it on Claude Code v2.1.311.

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

## 12. `model: inherit` in an agent's frontmatter overrides `CLAUDE_CODE_SUBAGENT_MODEL`

Since Claude Code **v2.1.251** a subagent's model is resolved in this order: the per-invocation
`model`, then the agent's frontmatter `model` (where `inherit` selects the main conversation's
model), then the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable, then the main
conversation's model. Before v2.1.251 the variable came first. Source:
[sub-agents, "Choose a model"](https://code.claude.com/docs/en/sub-agents).

So an explicit `model: inherit` — which reads like "no opinion" — silently beats a user's
`CLAUDE_CODE_SUBAGENT_MODEL`. Omitting the field gives the same default *and* lets the
variable apply, which is why no agent in this plugin sets `model:` at all (the verifier
enforces it). A `model` a workflow passes per call still outranks the variable; set
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+) to force one model everywhere.

---

## 13. A model blocked by `availableModels` is substituted, not refused

When an organization's `availableModels` allowlist blocks the model a subagent or a workflow
`agent()` call asks for, Claude Code **runs the agent on a substituted model rather than
failing the request**; a blocked family alias resolves to the newest permitted version of that
family. Sources: [model configuration](https://code.claude.com/docs/en/model-config) ("Subagent
or teammate override … runs the subagent or teammate on a fallback model rather than failing
the request") and [workflows, "Cost"](https://code.claude.com/docs/en/workflows), read against
Claude Code v2.1.311.

The run carries on. `/delivery:orchestrate` records in each PR's `models` the model it
**requested** for each phase, so under a restrictive allowlist that field can name a model the
phase never ran on. If your organization sets `availableModels`, check that `sonnet` (or the
`--small-model` you pass) is on it before comparing tiers.

---

## 14. Plugin agents ignore `hooks`, `mcpServers` and `permissionMode`

> "For security reasons, plugin subagents don't support the `hooks`, `mcpServers`, or
> `permissionMode` frontmatter fields. These fields are ignored when loading agents from a
> plugin."

Source: [sub-agents, "Choose the subagent scope"](https://code.claude.com/docs/en/sub-agents);
the [plugin components page](https://code.claude.com/docs/en/plugins/components) adds
`initialPrompt` to the ignored list. Checked against Claude Code v2.1.311.

Setting one produces no error: the agent loads without it. A `permissionMode: acceptEdits` on a
plugin agent does not loosen anything, and an `mcpServers` block does not give the agent a
server. Ship hooks in the plugin's `hooks/hooks.json` and servers in its `.mcp.json`, or copy
the agent into `.claude/agents/` (project) or `~/.claude/agents/` (user) where the fields apply.

---

## The meta-gotcha

All of the above are instances of one thing:

> **In this system, the failure mode is silence.**

An agent that did not load, a phase that did not run, a skill that was not discovered and a
delegation that never happened all look identical from the outside — like a session that
completed and reported success. That is the entire reason this plugin packages its pipeline as
workflows: a script that does not run a line is a bug you can find, whereas a model that did
not choose to dispatch an agent leaves nothing behind to find.
