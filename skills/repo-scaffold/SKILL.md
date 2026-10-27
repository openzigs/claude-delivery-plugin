---
name: repo-scaffold
description: "Scaffolds a new project repository with the optimal tech stack. Detects or asks for project type (web app, API server, CLI, library), researches best-fit technologies using web search and library docs, creates local + remote repos, and applies industry-standard scaffolding with CI/CD, linting, testing, and docs structure."
argument-hint: "[project-name] — name for the new project repository"
---

# Repository Scaffold

## Purpose

This skill guides the **delivery:code-planner** agent through creating a new project from
scratch: selecting the right tech stack, scaffolding the repo with best practices, and
pushing to GitHub. It handles the full lifecycle from "I have an idea" to "I have a repo
ready for development."

## Per-Project Constraints

Every other skill in this plugin begins by reading the project's `CLAUDE.md` (or
`AGENTS.md`) and obeying it exactly — that file is where a project states its own hard
rules: build/test/lint commands, coverage floors, changelog convention, protected paths.

**This skill is the one that writes that file.** There is no `CLAUDE.md` to read when you
start, because the repo does not exist yet. Your job in Step 5 is to emit the file the rest
of the pipeline will read, and to make it accurate — every command in it must be a command
you actually ran successfully during scaffolding, not a command you assumed would work.

Two exceptions to "there is nothing to read":

- **Step 0b/0c find an existing repo.** Then this skill does not scaffold at all. Read that
  repo's `CLAUDE.md` / `AGENTS.md` (and `.claude/delivery.md` if present), obey it, and hand
  off to `/delivery:epic-planner`. Do not overwrite an existing `CLAUDE.md`.
- **You are scaffolding inside an existing workspace** that already carries conventions
  (a monorepo package, a fork). Read whatever instruction files are above you and inherit
  them rather than contradicting them.

## When to Use

- The user wants to start a new project and doesn't have a repo yet
- The user describes an application and needs a repo created
- The user asks to "scaffold", "bootstrap", "create a new project", or "set up a repo"
- The `delivery:code-planner` agent detects no local or remote git repo

## Tools

GitHub work uses the **`gh` CLI**. It is always available, authenticates independently of
any MCP server, and every operation this skill needs (`gh repo create`, `gh api user`,
`gh api`, `git push`) is a one-shot command. **No step in this skill may depend on an MCP
server being configured.**

| Need | Primary | Notes |
|------|---------|-------|
| Create remote repo | `gh repo create` | Owner comes from the user or `gh api user -q .login` |
| Identify the current GitHub user | `gh api user -q .login` | Never hardcode an owner or org |
| Push scaffolding | `git push -u origin main` | Plain git; the remote is already set |
| Library/framework docs | Context7 MCP **if configured**, else `WebFetch` | Optional — same ground either way |
| Best-practice / starter-template research | Tavily MCP **if configured**, else `WebSearch` | Optional |
| Fetch a known URL | `WebFetch` | Always available |

If Context7 or Tavily happen to be configured, use them — they are faster and more current
for library specifics. If they are not, `WebSearch` and `WebFetch` cover the same ground and
the workflow is unchanged. Never report a step as blocked because an MCP tool was missing.

## Workflow

### Step 0: Detect or Acquire Repo

#### 0a. Did the user name a specific repo in their prompt?

Look for any of:
- A full URL: `https://github.com/<owner>/<repo>`
- An `<owner>/<repo>` short form
- A plain repo name that can be inferred from context

If a repo was named, go to **Step 0b** to ensure it's on disk and up-to-date.
If no repo was named, proceed to **Step 0c**.

#### 0b. Clone or Pull the Named Repo

Resolve the owner and repo name from the user's input. Use `github.com` as the default host.

Build the clone path: `{workspace_dir}/{REPO}` (or the user's preferred directory).

**If the directory does not exist** — clone it:
```bash
gh repo clone <OWNER>/<REPO>
# or: git clone https://github.com/<OWNER>/<REPO>.git
```

**If the directory already exists** — pull latest from the default branch:
```bash
cd <REPO> && git fetch origin && \
  git checkout "$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)" && \
  git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)"
```

Do not assume the default branch is `main` — ask the remote. Plenty of repos are still on
`master` or use something else entirely, and a hardcoded `git checkout main` fails in a way
that reads like a missing repo.

After clone/pull, set the working repo path, read the repo's `CLAUDE.md` / `AGENTS.md`, and
proceed directly to the **`/delivery:epic-planner`** skill — no scaffolding is needed for
existing repos.

> If clone fails (auth, not found, typo), report the error immediately and ask the user to
> confirm the repo name/URL and that they have access. Do not proceed until the repo is
> available locally.

#### 0c. No Repo Named — Detect What's Local

1. Check if the current workspace has a `.git` directory
2. Check for a project manifest: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
   `build.gradle`, `pom.xml`, `Gemfile`, `*.csproj`, or similar
3. If a repo exists locally, check for a remote: `git remote -v`
4. If a remote exists, confirm it resolves: `gh repo view --json nameWithOwner`

**If repo exists**: Skip to the `/delivery:epic-planner` skill — scaffolding is not needed.

**If no repo exists**: Proceed with the interview.

### Step 1: Project Interview

Ask the user the following questions. Present sensible defaults based on context.

#### 1a. Project Type (Required)
> **What type of project are you building?**
> - **Web Application** (frontend + optional backend)
> - **API Server** (REST/GraphQL backend service)
> - **CLI Tool** (command-line application)
> - **Library/Package** (reusable module)
> - **Full-Stack Application** (monorepo with frontend + backend)
> - **Mobile Application** (React Native, Flutter, etc.)
> - **MCP Server** (Model Context Protocol server)
> - **Other** (describe it)

#### 1b. Project Description (Required)
> **Describe what this project does in 1-3 sentences.**

#### 1c. Project Name (Required)
> **What should the repository be called?** (kebab-case recommended)

#### 1d. Owner and Visibility (Required)
> **Which GitHub account or organisation should own it?** Default to the authenticated user
> from `gh api user -q .login`, but show that value and let the user override it — a repo
> created under the wrong owner is annoying to move. Never assume an org.
>
> **Public or private repository?** (default: private)

#### 1e. Additional Context
> **Any specific requirements?** (auth needs, database, real-time features, integrations,
> compliance or data-handling constraints, deployment target)

Ask explicitly about **data sensitivity**. If any class of file must never be committed or
read (customer data, regulated material, secrets, licensed datasets), capture it now — it
belongs in `.gitignore` **and** in the "Known Gotchas" / protected-paths section of the
generated `CLAUDE.md`. A rule that lives only in a chat message is not a control.

### Step 2: Technology Research & Recommendation

Based on the project type and description, research the best tech stack. Everything below is
a **starting point for a recommendation**, not a house style — present each concrete stack as
one option among alternatives, and let the user's requirements pick the winner.

Read `${CLAUDE_PLUGIN_ROOT}/skills/repo-scaffold/STACK_GUIDE.md`, section "Choosing a stack", for the per-type
starting points (frontend, backend, CLI, library, MCP server) and the recommendation format.

Wait for user confirmation before proceeding. Do not scaffold on an unconfirmed stack —
undoing a scaffold is more work than asking.

### Step 3: Create Repository

#### 3a. Resolve the Owner

```bash
gh api user -q .login          # default owner; show it to the user and allow an override
```

Use the owner the user confirmed in Step 1d. Never hardcode an account or organisation.

#### 3b. Create the Remote Repository

```bash
gh repo create <OWNER>/<PROJECT_NAME> \
  --private \
  --description "<description from the interview>"
# swap --private for --public per the interview; omit --clone, we push our own scaffolding
```

If the description is long or contains characters the shell will fight you over, write it to
a file first and pass it by file rather than inlining it.

#### 3c. Initialize the Local Repository

```bash
mkdir <PROJECT_NAME> && cd <PROJECT_NAME> && git init -b main && \
  git remote add origin https://github.com/<OWNER>/<PROJECT_NAME>.git
```

### Step 4: Scaffold Project

Apply the appropriate scaffold based on the **confirmed** tech stack. The commands below are
illustrative shapes, not pinned truth — verify the current invocation for the version you
resolved in Step 2 before running it, and adjust. Run each scaffold and confirm it exits
clean; a command that fails here becomes a wrong command in `CLAUDE.md` later.

The per-stack scaffold commands are in `${CLAUDE_PLUGIN_ROOT}/skills/repo-scaffold/STACK_GUIDE.md`, section
"Scaffold commands".

Whatever the stack, before you leave this step **run the gate once and record what it
actually prints**: install, build, test, lint. Those verified commands are the single most
valuable thing in the file you write next.

### Step 5: Create Standard Files

Every project gets these files regardless of stack.

#### `.github/ISSUE_TEMPLATE/1-epic.yml`
Create from the epic template (see the `/delivery:epic-planner` skill).

#### `.github/ISSUE_TEMPLATE/2-feature.yml`
Create from the feature template.

#### `.github/ISSUE_TEMPLATE/3-bug.yml`
Create from the bug template.

#### `.github/PULL_REQUEST_TEMPLATE.md`
Standard PR template with a checklist: linked issue, what changed, how it was tested, docs
updated, gate run locally.

#### `docs/ARCHITECTURE.md`
Initial architecture document from `ARCHITECTURE_TEMPLATE.md` (living document — maintained
by the `delivery:code-issue` agent).

#### `docs/USER_GUIDE.md`
Initial user guide from `USER_GUIDE_TEMPLATE.md` (living document — maintained by the
`delivery:code-issue` agent).

#### `CLAUDE.md` (repo root) — the important one

This is the file every later stage of the pipeline reads first. Generate it with high
intent: it exists so an agent can work efficiently in this repo without exploring from
scratch, and so a human onboarding has one accurate page instead of five stale ones.

- Put it at the **repo root** as `CLAUDE.md`.
- `AGENTS.md` is the equivalent file for other tools; if the project wants one, make it a
  symlink to `CLAUDE.md` or a copy, and say in the file which is canonical.
- A `.github/copilot-instructions.md` can point at the same content the same way — one
  source of truth, not three drifting ones.

Generate content covering all of the following sections (keep the total file under about
two pages / ~150 lines — length is what makes these files go stale):

```markdown
# {Project Name}

## Project Summary
{1-2 sentence description of what this does and who it's for}

## Tech Stack
| Layer | Technology | Version |
|-------|-----------|---------|
| ...   | ...       | ...     |

## Commands
<!-- State these EXACTLY. Every command here must be one you ran successfully during
     scaffolding. Include any prefix that matters: a workspace directory to cd into, an
     interpreter path, a task-runner verb. If a bare tool name on PATH would resolve to a
     DIFFERENT installation than this project's, say so here and give the explicit form. -->
- Install: `{install command}`
- Build: `{build command}`
- Test: `{test command}`
- Test with coverage: `{coverage command}`
- Lint: `{lint command}`
- Typecheck: `{typecheck command, or note which command already covers it}`
- Run dev server: `{dev command}`

## Project Layout
{Key directories and their purpose — 6-10 lines max}
- `src/` — ...
- `tests/` — ...
- `docs/` — ARCHITECTURE.md, USER_GUIDE.md
- `.github/` — CI workflows, issue and PR templates

## Architecture Overview
{2-4 sentences on how the system is structured — layers, services, data flow}

## Coding Conventions
- Language: {language} with {strict/standard} mode
- Style: {linter/formatter config locations}
- Naming: {brief naming conventions}
- Testing: {framework, co-located vs. separate test directory, coverage expectation}
- Error handling: {pattern used in the project}
- Branches: `feature/issue-{N}-{slug}`; PRs into `{default branch}` with `Closes #N`
- Changelog: {the convention, if any — say plainly if there is none}

## CI Pipeline
{The GitHub Actions jobs and what each one checks — names, triggers, and what a red job
 means. Keep this in sync with .github/workflows/.}

## Known Gotchas
{Non-obvious setup steps, timing issues, workarounds. Also: any path that must never be
 committed or read, and why. Write the reason, not just the path — a rule whose reason is
 missing gets "fixed" by the next person.}

## Trust These Instructions
Rely on this file rather than exploring the codebase from scratch. Only search if this file
is incomplete or appears out of date — and if you find it out of date, fix it in the same PR.
```

> **Note**: This file is a **living document** — the `delivery:code-issue` agent updates it
> whenever architectural changes occur (new modules, changed commands, new conventions).

#### `.claude/delivery.md` (optional stub)

Optionally emit a `.claude/delivery.md`: the opt-in file where a project states constraints
aimed specifically at this delivery pipeline, as opposed to general project rules that
belong in `CLAUDE.md`. Offer it; do not force it. **Its absence is completely harmless** —
every skill in the plugin treats "no `.claude/delivery.md`" as "no extra constraints" and
carries on.

```markdown
# Delivery pipeline constraints

<!-- Optional. Delete this file if you have nothing to say here; nothing breaks. -->

## Gate
<!-- The exact command(s) that must pass before a PR is opened. -->

## Coverage
<!-- A floor, if the project enforces one, and where it is configured. -->

## Review
<!-- Anything the reviewer must always check for this codebase. -->

## Protected paths
<!-- Paths agents must not modify or read, and why. -->

## Handoffs
<!-- Any deviation from the default issue -> branch -> PR -> review -> merge flow. -->
```

#### `README.md`
Project README with:
- Project description
- Tech stack
- Getting started instructions
- Development workflow
- Project structure

#### Standard config files
- `.gitignore` (appropriate for the stack, plus anything flagged as sensitive in Step 1e)
- `.editorconfig`
- Linting and formatting configs
- CI workflow (`.github/workflows/ci.yml`)

#### CI workflow

Use **GitHub-hosted runners** (`runs-on: ubuntu-latest`) unless the user explicitly asks for
self-hosted infrastructure — hosted runners work on day one for everybody, need no
provisioning, and are the only thing you can assume exists.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Set up the toolchain for the chosen stack, with dependency caching
      - name: Install
        run: {install command}
      - name: Lint
        run: {lint command}
      - name: Test
        run: {test command}
      - name: Build
        run: {build command}
```

Keep the job names and step names in the workflow identical to the names you list in
`CLAUDE.md`'s "CI Pipeline" section, so a red check maps to a documented step without
anyone having to guess.

### Step 6: Initial Commit & Push

```bash
git add -A && git commit -m "chore: initial project scaffold

Tech stack: {summary}" && git push -u origin main
```

Do not `git add -f` past your own `.gitignore`. If a file is ignored and you believe it
should be committed, fix the ignore rule deliberately — force-adding is how sensitive
material reaches a remote, and a push to a remote cannot be taken back by deleting the file
in a later commit.

### Step 7: Verify Before Handoff

Before declaring success, confirm the repo is genuinely usable:

1. `git status` is clean and `git log --oneline` shows the scaffold commit.
2. The remote has it: `gh repo view --json url,visibility -q '.url + " " + .visibility'`.
3. **Every command in `CLAUDE.md` runs.** Execute install, lint, test, build once more from
   a clean state. A `CLAUDE.md` with a command that does not work is worse than no file,
   because every later agent trusts it by design.
4. CI is green, or you know exactly why it is not:
   ```bash
   gh run list --limit 3
   gh run watch "$(gh run list --limit 1 --json databaseId -q '.[0].databaseId')"
   ```
   A run stuck in `queued` on GitHub-hosted runners is normally just queue depth. Check
   before reporting an outage.

### Step 8: Handoff

Present to the user:
- **Repository URL**: link to the new GitHub repo
- **Tech stack summary**: what was installed and why
- **The verified commands**: paste the gate you actually ran
- **Next steps**: "Ready to plan your epics and issues. Describe what you want to build."

Then transition to the **`/delivery:epic-planner`** skill.

## Error Recovery

| Scenario | Action |
|----------|--------|
| `gh repo create` fails | Check `gh auth status`; confirm the owner exists and you can create there; suggest manual creation and `git remote add` |
| Name already taken | Ask the user for another name — do not silently append a suffix |
| Scaffold command fails | Re-check the current invocation for that version; fall back to manual file creation |
| Context7/Tavily not configured | Not an error — use `WebSearch`/`WebFetch` and known best practices |
| User rejects recommendation | Re-interview with more specific questions; do not scaffold anything meanwhile |
| Package install fails | Check the language runtime version against the framework's requirement; report the actual version mismatch |
| Push rejected | The remote was auto-initialised. Fetch, rebase onto it, push again — do not force-push over content you have not read |
| CI red on first run | Fix it now. A repo that is handed over red teaches everyone downstream to ignore the checks |

## Tips

- Always confirm the tech stack with the user before scaffolding.
- Resolve the owner from `gh api user` or the user's answer; never hardcode an account or org.
- Do not assume a default branch name — ask the remote.
- Create the remote repo before the first push, but scaffold locally so `auto_init` never
  produces a conflicting initial commit.
- Include a comprehensive `.gitignore` from the start, including anything the user flagged
  as sensitive.
- Pin the versions you verified. "latest" in a doc is a fact with a short shelf life.
- **A test that cannot fail is not a test.** The scaffold's smoke test counts: after writing
  it, mutate the implementation and watch it go red, then revert. A green suite that stays
  green when the code is broken has taught you nothing and will keep doing so for the life
  of the project.
- The `docs/` folder is created here but maintained by the `delivery:code-issue` agent.

## Shell Execution Rules

**Critical — follow these so runs stay non-interactive and terminate:**

1. **Batch commands** — chain related commands into a SINGLE call using `&&`
   (`npm install && npm run lint && npm run test && npm run build`). Do not split one logical
   step across several invocations.

2. **No watch mode** — never run watch or interactive commands. Always enforce one-shot
   execution:
   - Use the run-once form of the test runner (e.g. `vitest run`, plain `pytest`,
     `go test ./...`), never the `--watch` variants.
   - Dev servers and `--reload` processes are long-running; they never belong in a gate.

3. **No background processes** — never use `&`, `nohup`, or `disown`. Each command must run
   to completion before continuing.

4. **No interactive sessions** — never launch a bare REPL (`node`, `python`, a database
   shell without `-c`). Use one-shot variants with command flags. Scaffolding tools are the
   usual trap here: pass the non-interactive flags, or the run hangs on a menu prompt you
   cannot see.

5. **Long text goes in a file, never on the command line.** A repo description, an issue
   body, a PR body — write it with the file-writing tool and pass it by path
   (`gh issue create --body-file <path>`, `gh pr create --body-file <path>`,
   `gh repo edit --description "$(cat <path>)"`). Inlining multi-line markdown into a shell
   command corrupts it on backticks, quotes and `$`, and the failure is silent — the issue
   posts with mangled content.

6. **Lint only what you changed** when working in an existing tree that has pre-existing
   findings. A whole-repo lint that reports hundreds of pre-existing problems can never go
   green and says nothing about your change. A new finding in a file you touched is yours;
   greening the repo is not this change's job. By the same rule, **do not reformat files you
   did not come to change** — a drive-by formatter run is pure diff noise and will be
   treated as a review finding. (A freshly scaffolded repo is the one place where formatting
   the whole tree is correct: do it once, in the scaffold commit, before anyone else has a
   branch open.)

7. **The gate is whatever `CLAUDE.md` says it is.** After Step 5 that file exists and names
   the exact commands. Run those, in that form, including any directory prefix or explicit
   interpreter path. Do not substitute the command you would expect for the command the
   project documents.
