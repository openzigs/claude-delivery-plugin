# delivery — a Claude Code plugin

A project-agnostic delivery pipeline for Claude Code: two workflows, seven agents and
eight skills that take a GitHub issue from implementation through **independent review**,
fix and re-review — or turn a topic into a filed epic with sub-issues.

It hardcodes nothing about any project. Every dispatched prompt reads the repository's own
`CLAUDE.md` for its hard rules, so the same plugin works in a Go service, a React app, a
Rust CLI or a polyglot monorepo.

---

## Why this exists: Claude Code cannot invoke an agent directly

This is the finding the whole plugin is built on, and it is worth stating before anything
else.

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

That is not a hypothetical. It is what happens in practice: a reviewer agent can sit in a
repository, fully working, through dozens of merges without being run once, because nothing
the executing model read told it when to use it. An agent nobody is told to dispatch is
indistinguishable from one that does not exist.

**A workflow is different. A workflow is a command.** You type `/delivery:orchestrate 412`
and a JavaScript file runs. Its phase sequence is code, not intention:

```js
phase('Implement')
const built = await agent(/* ... */, { agentType: 'delivery:code-issue' })

phase('Review')
const reviewed = await agent(/* ... */, { agentType: 'delivery:code-review' })
```

The review phase cannot be skipped, because skipping it would require the script not to
execute a line. That single property — *the sequence is code* — is the reason this plugin
is packaged as workflows that dispatch agents, rather than as a set of agents and a written
convention asking you to use them in order.

Everything else here is in service of that: the agents are the workers the workflows
dispatch, and the skills are the procedures those workers follow.

---

## Quick start

```bash
# Try it without installing anything (per-session, from a checkout):
claude --plugin-dir /path/to/claude-delivery-plugin

# Then, inside that session:
/delivery:orchestrate 412
```

Or install it permanently:

```bash
claude plugin marketplace add openzigs/claude-delivery-plugin
claude plugin install delivery@claude-delivery-plugin
```

Full instructions, including the IDE extensions and private-repository access, are in
[`docs/installation.md`](docs/installation.md).

---

## What is in the box

### Workflows — typed slash commands, sequence guaranteed

| Command | What it does | Ends at |
|---|---|---|
| `/delivery:orchestrate <issue \| description>` | Preflight → Implement → Review → *(Fix → Re-review, only if review found something blocking)* | An open PR, **never merged** |
| `/delivery:plan-epic <topic \| path \| URL>` | Preflight → Research → Plan | Filed GitHub issues, **no code written** |

Both start with a **Preflight** phase that reads the project's own rules out of the
repository and carries them verbatim into every later prompt. That is how a generic
pipeline obeys a specific project — see
[Per-project configuration](#per-project-configuration).

### Agents — the workers

| Agent | Role | Write tools? |
|---|---|---|
| `delivery:orchestrator` | Runs the whole pipeline, dispatching the others. Use when the user says "work on issue N" without naming agents | No |
| `delivery:code-issue` | Implements one issue end to end: TDD, coverage, branch, PR, CI watch | Yes |
| `delivery:code-review` | Reviews a PR against requirements, OWASP, design, performance, tests; publishes inline GitHub comments | No — deliberately |
| `delivery:code-planner` | Files a structured epic with sub-issues, Mermaid diagrams, story points, phase order | Yes |
| `delivery:research` | Synthesizes local files, web pages and library docs into a research summary | No |
| `delivery:e2e-test` | Writes Playwright specs mapped to acceptance criteria | Yes |
| `delivery:ui-vision` | Drives a real headed browser through a running app and files what it finds | No |

The reviewer and the QA agent hold `disallowedTools: Write, Edit` on purpose. Removing the
write tools from a reviewer's schema is a materially stronger guarantee than trusting it not
to reach for them: editing the code under review stops being the near-at-hand move.

### Skills — the procedures

`code-issue`, `code-review`, `e2e-test`, `epic-planner`, `repo-scaffold`,
`research-gather`, `resolve-pr-comments`, `ui-vision`.

Each is invoked namespaced — `/delivery:code-review` — and each is also reachable through
the `Skill` tool by an agent that has it in `tools:`. See
[`docs/usage.md`](docs/usage.md) for what each one does and when to reach for it.

---

## Verifying it loaded

**The failure mode is silence.** A plugin that does not load produces no error; a
misnamed agent simply never appears. Check, do not assume:

```bash
# Component inventory and token cost, from a directory:
claude --plugin-dir /path/to/claude-delivery-plugin plugin details delivery

# Or, once installed:
claude plugin list
claude plugin details delivery
```

You should see `Skills (8)` and `Agents (7)`.

> **Note:** `claude plugin details` does **not** list workflows — that is true of every
> plugin, not a defect in this one. To confirm the workflows registered, type `/` in an
> interactive session and look for `/delivery:orchestrate` and `/delivery:plan-epic`, or
> ask a headless session:
>
> ```bash
> claude --plugin-dir /path/to/claude-delivery-plugin \
>   -p "Without using any tools, list every slash command available to you that starts with 'delivery'."
> ```

More checks, including what each failure looks like, are in
[`docs/installation.md`](docs/installation.md#verifying-it-loaded).

---

## MCP servers: what this plugin needs, and what it merely uses

**Nothing here requires an MCP server.** Every step works with the built-in tools plus the
`gh` CLI, and that is deliberate: an agent whose procedure depends on a server the user has
not configured fails by quietly skipping a step, which is the failure mode this plugin
exists to remove.

| Server | Used by | Required? |
|---|---|---|
| **Playwright** (`mcp__playwright__*`) | `delivery:e2e-test`, `delivery:ui-vision` | **Yes, for those two.** Driving a real browser is what they do; without it they cannot work and will say so |
| **Tavily** (`mcp__tavily__*`) | `delivery:research`, `delivery:code-planner` | No — an accelerator over `WebSearch` |
| **Context7** (`mcp__context7__*`) | `delivery:research`, `delivery:code-planner` | No — an accelerator over `WebFetch` on official docs |
| **GitHub** | *nobody* | No — every agent uses the `gh` CLI instead |

GitHub is deliberately absent. The `gh` CLI authenticates separately, works in every
environment these agents run in, and does not silently stop working when an MCP server's
credentials go stale — which is a real failure mode, and one that presents as an agent
inexplicably unable to read a pull request.

**A `tools:` allowlist naming `mcp__tavily__*` is a permission, not a promise.** It cannot
conjure a server you have not configured. The two agents that name those patterns are told
to check rather than assume, and to treat them as faster paths rather than dependencies —
so the plugin behaves identically whether or not you have them, only slower.

**[docs/mcp-servers.md](docs/mcp-servers.md) has the registration commands** for macOS,
Linux and Windows, including the Windows `npx.cmd` and quoting traps that make a server
register successfully and then silently fail to start. It names the environment variable
each key goes in and links to the vendor for the key itself, rather than reproducing signup
flows that go stale. If you want to *remove* Playwright's requirement, the two browser
agents are the ones to fork — see [docs/customising.md](docs/customising.md).


## Per-project configuration

The generic agents cannot hardcode your project's rules, but they still need them. The
convention is one sentence:

> **Every dispatched prompt instructs the agent to read the project's `CLAUDE.md` (or
> `AGENTS.md`) first and obey it exactly**, because that is where a project states its own
> hard rules.

On top of that, both workflows run a **Preflight** phase that reads those files and quotes
the rules *verbatim* into every subsequent prompt — because a subagent starts with none of
the caller's context, and naming a file is weaker than carrying its contents.

Two files participate, both optional:

| File | Purpose | If missing |
|---|---|---|
| `CLAUDE.md` or `AGENTS.md` (repo root) | The project's own instructions — commands, coverage floors, protected paths, conventions | Gates are inferred from CI config and manifests, and the report says so |
| `.claude/delivery.md` | **Opt-in.** Delivery-pipeline constraints you want carried into every dispatched prompt, kept out of the always-loaded `CLAUDE.md` | Nothing happens. Its absence is normal and harmless |

A copy-and-edit template lives at
[`docs/templates/delivery.md`](docs/templates/delivery.md), and the full explanation —
including what to put where, and why the split exists — is in
[`docs/per-project-configuration.md`](docs/per-project-configuration.md).

---

## Precedence and gotchas

Every item in this list fails **silently**. Read
[`docs/precedence-and-gotchas.md`](docs/precedence-and-gotchas.md) before debugging
anything; the short version:

- A project's `.claude/agents/<name>.md` **silently overrides** a plugin agent of the same
  name. Useful for customising; invisible when accidental.
- **Workflows cannot be symlinked.** Claude Code refuses to write through a symlink, so a
  symlinked workflow file breaks in ways that do not name the symlink. Copy it.
- An agent's `name:` must be lowercase-with-hyphens and **match its filename stem**, or the
  agent does not load and nothing says so.
- An orchestrator whose `tools:` omits `Agent` runs happily, narrates a plausible pipeline,
  and **delegates nothing** — with no error anywhere.
- Agent-to-agent references must be namespaced: `Agent(delivery:code-issue)`, not
  `Agent(code-issue)`.

---

## Customising

Fork an agent, override one for a single project, or add your own workflow —
[`docs/customising.md`](docs/customising.md) covers all three, including the precedence
rules that decide which copy wins.

---

## Repository layout

```
.claude-plugin/
  plugin.json          # the plugin manifest (name, version, description, author)
  marketplace.json     # makes this repo a single-plugin marketplace of itself
agents/
  code-issue.md        # flat files, YAML frontmatter, name == filename stem
  code-planner.md
  code-review.md
  e2e-test.md
  orchestrator.md
  research.md
  ui-vision.md
skills/
  <name>/SKILL.md      # directories, one SKILL.md each
  repo-scaffold/       # ... plus ARCHITECTURE_TEMPLATE.md and USER_GUIDE_TEMPLATE.md
workflows/
  orchestrate.js       # flat files; each exports `meta` as a PURE literal
  plan-epic.js
scripts/
  verify-plugin.mjs    # stdlib-only structural checks; run it before every PR
docs/
  installation.md
  usage.md
  per-project-configuration.md
  precedence-and-gotchas.md
  customising.md
  templates/
    delivery.md        # copy to <your project>/.claude/delivery.md
    CLAUDE.md          # a starting point if your project has none
LICENSE
README.md
```

## Contributing

1. Branch from `main`.
2. Make the change. If you touch an agent, keep `name:` equal to the filename stem. If you
   touch a workflow, keep `meta` a **pure literal** — no variables, no calls, no template
   interpolation. The runtime parses `meta` without executing the module and rejects
   anything else.
3. Validate. All three, in this order:
   ```bash
   node scripts/verify-plugin.mjs              # structure, frontmatter, meta purity, phase order
   claude plugin validate . --strict           # manifest schema, warnings as errors
   claude --plugin-dir . plugin details delivery   # expect Skills (8), Agents (7)
   ```
   `verify-plugin.mjs` executes each workflow body against stubbed `agent`/`phase`/`log`
   functions and asserts the phase order, including the conditional fix/re-review branch. It
   costs no tokens and catches the failures that are otherwise silent.
4. Keep it project-agnostic. This is the one rule that matters: no project names, no
   organisation names, no domain vocabulary, no toolchain assumptions, and no bare issue
   references — `#412` means nothing outside the repository it came from. If a war story
   makes the point, keep the *shape* of it and drop the citation: "a write that reports
   success while the read cannot see it", not the incident number.
5. Open a PR.

## License

MIT — see [LICENSE](LICENSE).
