# MCP servers

**Start here:** the only server this plugin *requires* needs **no account and no token**.
If you never intend to use the browser agents, you can skip this document entirely — every
other agent works with the built-in tools and the `gh` CLI.

| Server | Needed by | Credential | Without it |
|---|---|---|---|
| **Playwright** | `delivery:e2e-test`, `delivery:ui-vision` | **none** | those two agents cannot work, and will say so |
| **Tavily** | `delivery:research`, `delivery:code-planner` | API key | they use `WebSearch` — slower, not broken |
| **Context7** | `delivery:research`, `delivery:code-planner` | API key | they use `WebFetch` on official docs — slower, not broken |
| **GitHub** | *nobody* | — | not used; every agent uses the `gh` CLI |

## Why GitHub is deliberately absent

An MCP server's credentials can go stale while everything else keeps working, and the
symptom is an agent that inexplicably cannot read a pull request. That is not hypothetical —
it is why this plugin routes every GitHub operation through the `gh` CLI, which
authenticates separately through your system keychain and fails loudly when it cannot.

If you prefer the MCP route, add `mcp__github__*` to an agent's `tools:` in your own fork.
Nothing stops you; it simply is not the default.

---

## Playwright — required for the browser agents, no token

This is the one worth doing. It is a single command and asks for no account.

**macOS and Linux**

```bash
claude mcp add playwright --scope user -- npx -y @playwright/mcp@latest
```

**Windows (PowerShell)**

```powershell
claude mcp add playwright --scope user -- npx.cmd -y "@playwright/mcp@latest"
```

Two Windows-specific points, both of which produce a server that silently fails to start:

- **`npx.cmd`, not `npx`.** Windows resolves the `.cmd` shim; a bare `npx` may not be found
  when Claude Code spawns the subprocess, even though it works in your terminal.
- **Quote the package spec.** PowerShell treats `@` at the start of a token specially, so
  `@playwright/mcp@latest` unquoted can be mangled before `npx` ever sees it.

Browsers are downloaded on first use. If that fails behind a corporate proxy, run
`npx playwright install` once by hand and let it report the real error — the MCP server's
own failure message is less specific.

---

## Tavily and Context7 — optional accelerators, API key each

Both need a key. **This document deliberately does not reproduce their signup flows**: they
are third-party interfaces that change, and a stale copy of someone else's instructions is
worse than a link, because it looks authoritative while being wrong. What is stable, and
what you actually need, is the environment variable name and the command shape.

| Server | Environment variable | Where to get a key |
|---|---|---|
| Tavily | `TAVILY_API_KEY` | <https://tavily.com> — free tier available |
| Context7 | `CONTEXT7_API_KEY` | <https://context7.com> — free tier available |

**macOS and Linux**

```bash
claude mcp add tavily  --scope user -e TAVILY_API_KEY=your-key-here   -- npx -y tavily-mcp
claude mcp add context7 --scope user -e CONTEXT7_API_KEY=your-key-here -- npx -y @upstash/context7-mcp@latest
```

**Windows (PowerShell)**

```powershell
claude mcp add tavily   --scope user -e TAVILY_API_KEY=your-key-here   -- npx.cmd -y tavily-mcp
claude mcp add context7 --scope user -e CONTEXT7_API_KEY=your-key-here -- npx.cmd -y "@upstash/context7-mcp@latest"
```

### Keeping the key out of your shell history

Both commands put the key on the command line, where your shell records it. If that matters
to you:

**macOS / Linux** — read it from the environment instead, having exported it from a file
your shell sources but git ignores:

```bash
claude mcp add tavily --scope user -e "TAVILY_API_KEY=$TAVILY_API_KEY" -- npx -y tavily-mcp
```

**Windows (PowerShell)** — same idea:

```powershell
claude mcp add tavily --scope user -e "TAVILY_API_KEY=$env:TAVILY_API_KEY" -- npx.cmd -y tavily-mcp
```

On macOS you may prefer the Keychain; on Windows, `Credential Manager` or a per-user
environment variable set through **System Properties → Environment Variables**. Either way
the principle is the same: the key belongs somewhere your version control cannot reach.

---

## Scope: where the registration lands

`claude mcp add` takes `--scope local` (the default), `user`, or `project`.

| Scope | Lands in | Use when |
|---|---|---|
| `local` | this project, your machine only | trying something out |
| `user` | your machine, every project | **usually what you want** — these servers are not project-specific |
| `project` | a committed `.mcp.json` | the whole team should have it |

**Never use `--scope project` for a server that needs a key.** A committed `.mcp.json`
carrying `TAVILY_API_KEY=...` publishes your key to everyone with repository access, and
git history makes that effectively permanent. Commit the *server definition* with the key
read from the environment, or keep the whole thing at user scope.

---

## Verifying it worked

Registration succeeding is not the same as the server starting.

```bash
claude mcp list          # is it registered?
claude mcp get playwright # what exactly did it register?
```

The real check is whether the tools reach a session:

```bash
claude -p "List every tool you have whose name starts with mcp__. Just the names."
```

If Playwright registered correctly you will see `mcp__playwright__*` entries. If the list is
empty, the server is registered but not starting — run the underlying command yourself
(`npx -y @playwright/mcp@latest`) and read its output directly. A server that fails to spawn
is reported as an absent tool rather than as an error, which is why this check exists.

---

## Troubleshooting

**"The agent says it has no browser tools."**
Check the agent's `tools:` line actually names `mcp__playwright__*`. An allowlist that omits
it excludes the server no matter how well it is configured — *the allowlist wins*. This is
the most common cause and it produces no error.

**"It worked yesterday."**
Credentials expire. `claude mcp get <name>` shows the registration, not whether the key is
still valid. Run the underlying command by hand and read the failure.

**"It works in my terminal but not in Claude Code."**
Usually PATH: Claude Code spawns the subprocess without your interactive shell's profile.
Use an absolute path to `npx`, or register with `--scope user` after confirming
`command -v npx` resolves in a non-interactive shell (`bash -lc 'command -v npx'`).

**"Windows: the server starts and immediately exits."**
Almost always `npx` versus `npx.cmd`, or an unquoted `@scope/package` spec. See the
Playwright section above.

---

## Removing a server

```bash
claude mcp remove playwright --scope user
```

Removing Tavily or Context7 is safe at any time — the agents that name them treat them as
accelerators and fall back to `WebSearch`/`WebFetch`. Removing Playwright disables
`delivery:e2e-test` and `delivery:ui-vision` entirely; they will tell you so rather than
silently producing an empty result.
