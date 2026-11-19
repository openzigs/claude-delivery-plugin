# Installation

Three ways in, depending on what you are doing:

| You want to | Use |
|---|---|
| Try it, or develop the plugin itself | [`--plugin-dir` (per session)](#a-local-development-plugin-dir) |
| Use it every day | [Marketplace install](#b-marketplace-install-persistent) |
| Use it in VS Code or JetBrains | [IDE extensions](#c-ide-extensions) |

Everything on this page was run against **Claude Code 2.1.221**. Commands whose exact form
this document could not verify are marked **unverified** rather than guessed at — see
[What is not verified here](#what-is-not-verified-here).

---

## A. Local development (`--plugin-dir`)

The fastest path, and the one to use while editing the plugin. Nothing is installed and
nothing is written to your global configuration.

```bash
git clone https://github.com/openzigs/claude-delivery-plugin.git
cd /path/to/your-project
claude --plugin-dir /path/to/claude-delivery-plugin
```

The flag is repeatable, so you can load several plugins at once, and it accepts a `.zip` as
well as a directory:

```bash
claude --plugin-dir ./claude-delivery-plugin --plugin-dir ./another-plugin
```

Two things worth knowing:

- **The path is resolved once, at startup.** Editing an agent or workflow mid-session does
  not hot-reload it. Restart the session after a change.
- **`--bare` disables it.** `claude --bare` explicitly skips `--plugin-dir`, along with
  hooks, MCP servers and custom commands. If a plugin "isn't loading", check you did not
  inherit `--bare` from an alias or a wrapper script.

Verify it took effect:

```bash
claude --plugin-dir /path/to/claude-delivery-plugin plugin details delivery
```

---

## B. Marketplace install (persistent)

This repository is **both the plugin and a single-plugin marketplace of itself** — it ships
a `.claude-plugin/marketplace.json` alongside `.claude-plugin/plugin.json`. That means you
do not need a separate marketplace repository.

```bash
claude plugin marketplace add openzigs/claude-delivery-plugin
claude plugin install delivery@claude-delivery-plugin
```

`marketplace add` accepts a GitHub `owner/repo`, a URL, or a local path. All three work;
the local-path form is useful for testing a release before pushing it:

```bash
claude plugin marketplace add /path/to/claude-delivery-plugin
claude plugin install delivery@claude-delivery-plugin
```

### Private repositories

`openzigs/claude-delivery-plugin` is private, so the fetch has to authenticate. Claude Code
shells out to `git`, which means **whatever `git clone` can already reach, the marketplace
can reach**. In practice:

- **`gh` CLI already authenticated** — this is the simplest route. `gh auth setup-git`
  configures `git` to use your GitHub credentials, after which
  `claude plugin marketplace add openzigs/claude-delivery-plugin` works with no extra step.
- **SSH keys** — add the marketplace by its SSH URL instead of `owner/repo`:
  ```bash
  claude plugin marketplace add git@github.com:openzigs/claude-delivery-plugin.git
  ```
- **A personal access token** — configure it in your git credential helper rather than
  embedding it in a URL you then store in your settings file.

If `marketplace add` fails on a private repo, test the underlying operation directly —
`git clone https://github.com/openzigs/claude-delivery-plugin.git /tmp/probe`. If that
fails too, the problem is your git credentials, not Claude Code.

### Scopes

```bash
claude plugin install delivery@claude-delivery-plugin --scope user     # default: all your projects
claude plugin install delivery@claude-delivery-plugin --scope project  # this repo, committed to it
claude plugin install delivery@claude-delivery-plugin --scope local    # this repo, not committed
```

Use `--scope project` when you want everyone working in a repository to get the pipeline
automatically; the declaration lands in the project's settings and is committed.

### Managing it afterwards

```bash
claude plugin list                                  # what is installed, and enabled/disabled
claude plugin details delivery                      # component inventory + token cost
claude plugin update delivery                       # pull a newer version (restart to apply)
claude plugin disable delivery                      # keep it installed, stop loading it
claude plugin enable delivery
claude plugin uninstall delivery@claude-delivery-plugin
claude plugin marketplace update claude-delivery-plugin
claude plugin marketplace remove claude-delivery-plugin
```

---

## C. IDE extensions

Both the **VS Code** and **JetBrains** Claude Code extensions run the same `claude` CLI
underneath and read the same configuration from `~/.claude/`. That single fact settles most
of the question:

> **Install the plugin with the CLI, and the IDE extension picks it up.** There is no
> separate IDE-specific plugin registry to add it to.

### VS Code

1. Install the plugin once, from any terminal:
   ```bash
   claude plugin marketplace add openzigs/claude-delivery-plugin
   claude plugin install delivery@claude-delivery-plugin
   ```
2. **Restart the Claude Code session in VS Code** — close the Claude panel and reopen it,
   or run the *Developer: Reload Window* command. Plugins are resolved at session start, so
   an already-open session will not see a plugin installed after it started.
3. In the Claude chat input, type `/`. You should see `/delivery:orchestrate` and
   `/delivery:plan-epic` in the command list, alongside the built-ins.
4. To confirm the agents loaded, ask in the chat panel: *"list every slash command available
   to you that starts with delivery"*.

### JetBrains (IntelliJ IDEA, PyCharm, WebStorm, GoLand, …)

The same three steps. Install with the CLI, then restart the Claude Code tool window — in
JetBrains IDEs, closing and reopening the tool window is usually enough; *File → Invalidate
Caches / Restart* is the heavier option if it is not.

Slash commands appear in the same place as the built-in ones when you type `/` in the input
field.

### If the IDE cannot see a plugin the CLI can

Almost always one of these:

- **The IDE extension is using a different `claude` binary** than your shell. Check the
  extension's configured CLI path against `which claude`. A Homebrew `claude` and an
  `~/.local/bin/claude` have separate `~/.claude/` state only if `CLAUDE_CONFIG_DIR` differs
  — but they can be different *versions*, and an older one may not support plugins.
- **You installed with `--scope local` or `--scope project`** in a directory that is not the
  one the IDE has open.
- **The session predates the install.** Restart it.

---

## Verifying it loaded

The failure mode for every one of these components is **silence**. Nothing errors; things
simply do not appear. So check explicitly.

### 1. Is the plugin visible at all?

```bash
claude plugin list
```

Expect a line reading `delivery@claude-delivery-plugin` with `Status: enabled`. If you are
using `--plugin-dir`, `plugin list` will not show it — use step 2 instead.

### 2. Did all the components load?

```bash
# installed:
claude plugin details delivery
# or, from a directory:
claude --plugin-dir /path/to/claude-delivery-plugin plugin details delivery
```

Expect:

```
Component inventory
  Skills (12)  code-issue, code-review, cost-report, doctor, e2e-test, epic-planner, handoff, repo-scaffold, research-gather, resolve-pr-comments, retro, ui-vision
  Agents (9)  orchestrator, ui-vision, research, code-review, e2e-test, code-issue, code-planner, triage, land
```

**A count lower than 12 or 9 is the diagnostic.** A missing agent is almost always a
frontmatter problem — see
[precedence-and-gotchas](precedence-and-gotchas.md#3-an-agent-is-named-by-its-name-not-its-filename).

### 3. Did the workflows register?

`claude plugin details` does **not** report workflows. This is true of every plugin,
including Anthropic's own, so an empty workflow listing is not evidence of a problem — it is
evidence that this command does not cover them.

Check them directly instead:

```bash
claude --plugin-dir /path/to/claude-delivery-plugin \
  -p "Without using any tools, list every slash command available to you that starts with 'delivery'."
```

Expect `/delivery:orchestrate` and `/delivery:plan-epic`. Interactively, typing `/` in the
prompt does the same job.

### 4. Is the manifest well-formed?

```bash
claude plugin validate /path/to/claude-delivery-plugin --strict
```

`--strict` treats warnings as errors, and will flag unrecognised fields that the runtime
would otherwise tolerate in silence. Use it in CI.

---

## What is not verified here

Stated plainly, because a confidently wrong command wastes more time than an admitted gap:

- **The exact private-repository authentication path.** This document was written against a
  machine with `gh` already authenticated and `gh auth setup-git` applied. The `owner/repo`,
  SSH-URL and credential-helper routes above follow from Claude Code shelling out to `git`,
  but only the local-path and public-marketplace forms were executed end to end here.
- **JetBrains specifics.** The "install with the CLI, restart the tool window" model follows
  from the extension wrapping the same CLI, and the VS Code equivalent was reasoned from the
  same shared-`~/.claude/` behaviour. Neither IDE was driven interactively while writing
  this. If your IDE diverges, trust the IDE.
- **`/plugin` inside an interactive session.** Recent Claude Code versions expose a `/plugin`
  command that opens a plugin manager UI, which is a friendlier route than the CLI for
  installing and toggling plugins. Its exact menu layout is not documented here because it
  was not exercised.

What *was* executed end to end while writing this: `claude plugin validate --strict` on both
manifests, `claude plugin marketplace add <local path>`,
`claude plugin install delivery@claude-delivery-plugin`, `claude plugin list`,
`claude plugin details delivery`, `claude --plugin-dir <path> plugin details delivery`, and
a headless `claude --plugin-dir <path> -p ...` session that listed both `/delivery:*`
slash commands and every skill.
