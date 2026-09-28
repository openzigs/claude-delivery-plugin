---
name: code-issue
description: Autonomous senior developer workflow for resolving GitHub epics and sub-issues in any repository. Reads the project's own rules first, then runs test-driven development with mutation-verified tests, security scanning, branch and PR automation, CI validation and self-review, continuing through every sub-issue until the epic is complete. Holds an 80% coverage floor on touched code unless the project names its own.
argument-hint: "[epic or issue number] — GitHub issue number to resolve"
---

# Code Issue Resolver

## Purpose

This skill drives the **Code Issue** agent through a complete development workflow to resolve GitHub epics and their sub-issues. It orchestrates branching, test-driven development, security scanning, CI validation and pull request creation — all autonomously, with self-review checkpoints.

It is written to be repository-agnostic. Nothing here assumes a language, a package manager, a directory layout or a CI provider. Everything project-specific comes from the project itself, which is why the first step is not code.

## When to Use

- The user asks to "work on issue #N" or "resolve epic #N"
- The user wants to implement a feature or fix described in a GitHub issue
- The user says "start coding", "pick up the next issue", or "implement this"
- There is an epic with multiple sub-issues to complete in sequence

## Step 0: The project's rules come first

The project's `CLAUDE.md` is already in your context — do not re-read it. It is the authority
on the exact build / test / lint commands, coverage floors, the changelog convention, protected
paths and data-handling rules; where it and this document disagree, the project wins, and the
numbers here are defaults for a repository that names none. If the repository has an
`AGENTS.md` and no `CLAUDE.md`, read `AGENTS.md`. **If `.claude/delivery.md` exists, read it** —
it holds delivery-pipeline constraints such as branch naming, PR body shape and which gates
block a merge.

If the project states no commands, infer them from the repository — `package.json` scripts,
`Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, and above all the CI workflow under
`.github/workflows/` — and **say in your report what you inferred**. An inferred command
presented as a known one is how a "green" report gets made from a suite that never ran.

## Agent and tools

Execute with the **`delivery:code-issue`** agent.

GitHub work is done with the **`gh` CLI**. It is always available, it authenticates independently of
any server, and it is the interface every step below is written against. **MCP servers are optional
and may be absent — never make a step depend on one.** If a GitHub MCP server happens to be
installed it is a convenience, not the path; the `gh` command is.

## Workflow Overview

```
┌──────────────────────────────────────────────────┐
│  0. RULES — Read CLAUDE.md / .claude/delivery.md │
├──────────────────────────────────────────────────┤
│  1. PLAN — Read issue, analyze codebase, plan    │
├──────────────────────────────────────────────────┤
│  2. BRANCH — Create feature branch from default  │
├──────────────────────────────────────────────────┤
│  3. IMPLEMENT — For each sub-issue:              │
│     a. Write tests (TDD), verify they can fail   │
│     b. Implement code                            │
│     c. Run tests (>=80% on touched code)         │
│     d. Lint changed files and fix                │
│     e. Self-review checklist                     │
│     f. Ask about e2e tests (if UI)               │
├──────────────────────────────────────────────────┤
│  4. SECURITY — Scan for CVEs, OWASP, vulns       │
├──────────────────────────────────────────────────┤
│  5. CI — Run the project's gate to green         │
├──────────────────────────────────────────────────┤
│  6. DELIVER — Commit, push, create PR            │
│     • Include "Closes #N" for all issues         │
│     • Add inline review comments                 │
├──────────────────────────────────────────────────┤
│  7. HANDOFF — Present results, wait for review   │
└──────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Planning

1. Read the epic/issue: `gh issue view {number} --json title,body,labels,comments`
2. If it has sub-issues, read each one to understand the full scope and the boundaries between them
3. Look up library and API documentation you are unsure about — web search, the vendor's docs, or a
   documentation MCP server if one happens to be present. Do not guess an API signature you can check.
4. Analyze the codebase — identify affected files, the patterns already in use, and the conventions
   the surrounding code follows. Match them rather than importing your own.
5. Create a task tracking list with every issue to resolve, in dependency order

### Step 2: Branch Setup

1. Ensure the working directory is clean: `git status`
2. Switch to the default branch and pull: `git checkout main && git pull --ff-only origin main`
   (substitute the repository's actual default branch — `gh repo view --json defaultBranchRef`)
3. Create the feature branch. Use the project's naming convention if it states one; otherwise
   `feature/issue-{number}-{short-description}`
4. Push to establish remote tracking: `git push -u origin {branch-name}`

Always name the remote explicitly rather than relying on a default. A repository may carry more than
one remote, and some of them are unreachable provenance records rather than push targets.

**If the checkout may be shared with another session, do not `git checkout` in it** — a branch
switch under another agent moves its HEAD mid-task. Create your own worktree (`git worktree add`)
and remove it when you are done.

#### Resuming an Existing Branch (Merge Conflict Handling)

If the feature branch already exists (resuming interrupted work) and has fallen behind:

```bash
git checkout feature/{branch-name} && git fetch origin && git merge origin/main
```

- **Clean merge** → continue
- **Conflicts detected** → resolve systematically:
  1. List conflicted files: `git diff --name-only --diff-filter=U`
  2. Read each conflict — understand both the incoming (default-branch) and the current (feature)
     change before resolving
  3. Resolution strategy:
     - Foundation/infrastructure changes from the default branch → prefer the default branch
     - New feature code → preserve the feature branch's intent
     - Logic conflicts (both sides modified the same function) → merge the intent of both, and ask
       the user if the result is behaviorally ambiguous
  4. Stage resolved files and complete: `git add {files} && git merge --continue`
  5. Run the project's full test suite to verify the merge
  6. If tests fail after the merge, fix the regressions before proceeding

### Step 3: Implementation Loop

**For each sub-issue** (or the main issue if there are no sub-issues):

#### 3a. Test-Driven Development

- Write failing unit tests that verify the expected behavior, then implement the minimum code that
  makes them pass.
- **A test that cannot fail is not a test.** Verify each meaningful test by mutating the
  implementation — invert a condition, delete a write, return a constant, skip the persist — and
  watch the test go red. Then restore. **List the mutations you performed and what went red in the
  PR body.** A green suite proves nothing about tests that were never shown to fail, and this is the
  cheapest defence there is against a suite that passes over broken code.
- Run the project's coverage command — `CLAUDE.md` names it. Aim for **at least 80% on the code you
  touched**. If the project states its own floor, that number wins, including when it is lower than
  80: floors are often a ratchet set from a measurement, and a gate that is red on arrival gets
  routed around. Raise a floor in the same PR when your work clears a higher number, and give a
  reason in the PR body when you lower one.
- **The gate is the command's exit code, not your reading of the summary table.** Many suites
  enforce no floor at all unless invoked with the coverage flag — run the form that enforces, and
  let it decide.
- **Check whether CI actually runs that gate on pull requests.** Some pipelines skip the slow
  coverage job on PRs and run it only after merge, which means a drop goes red on the default branch
  with your name on it. If the gate is skipped on PRs, run it locally before opening the PR.
  `gh workflow run <workflow>.yml --ref <branch>` checks a branch on demand.
- This is a **hard gate** — do not proceed to delivery with the suite or the floor failing.

#### 3b. Defect shapes worth hunting

Most defects that survive a green suite have one of a few shapes. Look for these specifically:

- **A write that reports success while the read cannot see it.** This is the dominant shape, and it
  has four variants: the write went to the **wrong storage** (memory instead of the database, or a
  cache the reader never consults), the **wrong layer** (the store updated but the query path reads
  a different projection), the **wrong time** (written after the read, or inside a transaction that
  never commits), or the **wrong harness** (the test asserts against the object it just constructed
  rather than against a fresh read). Always assert by reading back through the same path a real
  consumer would use.
- **A scoped query that matches on the entity id without the scoping column.** Anything
  tenant-scoped, project-scoped or user-scoped must filter on the scope *and* the id. Getting this
  wrong is how one tenant's record silently satisfies another tenant's check — and it passes every
  single-tenant test in the suite.
- **State that nothing reads.** A store field that a control writes and no view renders from is a
  no-op that still passes tests. New client state needs a consumer that actually reads it.
- **An endpoint with no consumer.** Building an endpoint's first consumer is when its defects
  surface — shape mismatches, missing fields, wrong status codes, auth that was never exercised. If
  the issue delivers an API, wire at least one real caller, or say plainly in the PR that it ships
  unconsumed.

#### 3c. Lint and Format

- Run the project's linter and formatter as `CLAUDE.md` names them.
- **Lint only the files you changed when the tree carries pre-existing findings.** A whole-repo run
  against a tree with hundreds of legacy findings can never go green, so it says nothing about your
  change. Scope the linter to your changed files. A new finding in a file you touched is yours;
  greening the whole repository is not this change's job.
- **Do not reformat files you did not come to change.** A drive-by format on an untouched file is
  pure diff noise, it buries the real change, and it will be treated as a review finding.
- Fix errors and warnings in your own files — do not suppress them.

#### 3d. Self-Review Checklist

Before proceeding, verify:

- [ ] No unused variables or imports
- [ ] No hardcoded secrets, credentials, or API keys
- [ ] Code follows existing project conventions
- [ ] Error handling at system boundaries
- [ ] Tests cover happy path, edge cases and error cases — and each was seen to fail
- [ ] Scoped queries filter on the scoping column, not just the entity id
- [ ] No TODO/FIXME comments left unresolved
- [ ] Schema changes carry a migration with a *working* rollback
- [ ] Changelog handled per the project's convention (see Step 5.5)
- [ ] Architecture and user documentation updated if the change is architectural or user-facing

#### 3e. UI Consideration

If the issue involves UI changes:

- Ask the user: *"This issue includes UI changes. Would you like me to create Playwright e2e tests?"*
- If yes, hand off to the **`delivery:e2e-test`** agent, or run `/delivery:e2e-test`
- For live visual verification of a running app, hand off to **`delivery:ui-vision`**. Those two are
  the only agents that use Playwright MCP tools; this skill does not.

### Step 4: Security Scan

Before creating the PR, perform a security review of your own change:

1. **Dependency audit** — run the ecosystem's audit command (`npm audit --audit-level=moderate`,
   `pip-audit`, `cargo audit`, `govulncheck ./...`, `mvn dependency-check:check`). Start with the
   dependencies **you added or bumped**; a tree-wide audit over a legacy dependency set is
   background noise unless the project treats it as a gate.
2. **CVE lookup** — for any advisory ID the audit returns, read the full record before acting on it.
   Web search reaches the NVD and the GitHub advisory database; a CVE MCP server is a convenience if
   one is present, never a requirement.
3. **Severity gate** — CVSS 7.0 and above (High/Critical) **blocks the PR**. CVSS 4.0–6.9 (Medium)
   is noted but does not block unless it is exploitable in this codebase's context. Say which it is.
4. **Static review of changed files** — injection (SQL/NoSQL/OS command/LDAP), XSS, CSRF, insecure
   deserialization, path traversal, hardcoded credentials, weak crypto, and the rest of the OWASP
   Top 10.
5. **Report and fix** — present findings with severity and suggested fixes, apply them, re-run tests.

### Step 5: CI Validation

1. Find the CI configuration (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`).
2. Run the equivalent gate locally, batched, before pushing.
3. Verify: tests pass, linter clean on changed files, typecheck/build clean, coverage floor held.
4. After pushing, watch the remote run: `gh pr checks {number} --watch`.
5. **A job stuck in `queued` is ambiguous.** It is either a deep queue on healthy runners or a
   runner outage, and the two look identical from `gh pr checks`. Do not guess — check runner health
   (`gh api repos/<owner>/<repo>/actions/runners`) or ask. Never report CI as verified when it never
   ran.

### Step 5.5: Update Living Documents

After implementation and before creating the PR, update the project's living documents if they
exist. **If a document does not exist, skip it — do not create it here.**

#### Changelog

Follow the project's changelog convention if it has one — `CLAUDE.md` states it. **If it uses
per-PR fragments, add a fragment rather than editing the shared CHANGELOG.** A shared-file
convention puts every open PR on the same anchor line, so the first merge conflicts every other
branch and each one pays a rebase; a fragment is a new file and merges silently. **Run whatever
fragment validator the project ships** — a misnamed fragment is typically skipped in silence at
assembly. Never bump a version unless the project says that is part of a PR.

#### Architecture documentation

Update if this issue introduced new modules, services or components; new API endpoints or schemas;
changes to system architecture or the flow of information; new dependencies or integrations; or
infrastructure changes. Add the new components to the architecture diagram, update the project
structure section, document new endpoint contracts with request/response shapes, update the schema
section if it changed, and extend the technology stack table for new dependencies.

#### User documentation

Update if this issue introduced user-facing features or pages, changed an existing workflow, added
configuration options, or added CLI commands. Document new features with examples, update getting
started if onboarding changed, document new options with their defaults, and extend the FAQ where
you can anticipate the question.

#### The repository's agent-instruction file

`CLAUDE.md`, `AGENTS.md` or `.github/copilot-instructions.md` — update only when the change affects
how a future agent would navigate or build this repository.

| Change Type | Example | Update? |
|---|---|---|
| New top-level module or service | Added `src/payments/` | Yes — project layout + architecture |
| New build/test/run command | Added a migration script | Yes — build and run commands |
| New coding convention established | Adopted schema validation everywhere | Yes — coding conventions |
| New major dependency with unusual setup | Added a browser test runner, a cache server | Yes — known gotchas |
| New CI check or lint rule | Added a typecheck step to CI | Yes — CI / validation pipeline |
| Routine bug fix or small feature | Fixed a null check | No — no structural change |
| Test added for existing logic | Added a unit test | No |

**Surgical edits only.** Update the relevant section in place; do not rewrite the file. Add gotchas
only for non-obvious things you actually hit. Close with
`<!-- Last updated: {date} by delivery:code-issue resolving #{issue-number} -->`.

**Why this matters:** the agent-instruction file is injected into every future agent session for
this repository. Keeping it accurate is what stops the next agent re-exploring the codebase from
scratch — and what stops it running a command that no longer exists.

### Step 6: Delivery

1. Stage explicit paths with `git add <paths>` — never `git add -A`, which can sweep in another
   session's work in progress. Review `git status` first; never stage files that `CLAUDE.md` marks
   as protected, and never `git add -f` past an ignore rule. Some projects ignore paths because
   publishing them cannot be undone by a later commit.
2. Commit with a conventional message: `feat: [Issue #N] description` or `fix: [Issue #N] description`
3. Push the branch to the origin remote
4. Create the PR with `gh pr create --body-file <file>` — inlining prose into a `gh` command is
   how quoting bugs and truncation happen:
   - Title: `feat: Resolve #{epic-number} — {description}`
   - Body: summary of changes; `Closes #N` for every resolved issue; the coverage numbers; the
     mutations you used to prove the tests can fail; the security scan result
5. Add inline review comments on your own diff wherever a reviewer will want the reasoning. The
   publishing mechanics in `/delivery:code-review` apply identically here — including the rule that
   you cannot approve your own PR.

### Step 7: Handoff

Present to the user:

- **PR link**
- **Issues to close** — numbered list
- **Coverage** — the numbers, and which floor they were measured against
- **Tests** — the mutations performed and what went red
- **Security** — clean scan, or findings with status
- **Inferred commands** — if `CLAUDE.md` was absent, what you inferred and from where

Then state:

> **PR created and self-reviewed. All issues listed for closure. Please review. Type 'Next' when ready for the next epic.**

For a full implement → review → fix → re-review loop, hand the work to **`delivery:orchestrator`**
rather than driving the phases by hand.

## Example Invocation

```
/delivery:code-issue 42
```

```
Work on issue #15 — it has 4 sub-issues
```

```
Pick up where we left off on epic #42, starting from sub-issue #45
```

## Error Recovery

| Scenario | Action |
|----------|--------|
| `gh` push fails | Retry with `git push`; check `gh auth status` |
| PR creation fails | Fall back to opening the PR from the branch compare URL |
| Tests fail after implementation | Debug, fix, re-run — never weaken an assertion to make it pass |
| Security scan finds CVEs | Present to the user, suggest fixes, apply |
| CI job fails | Read the logs (`gh run view --log-failed`), fix, re-run |
| CI job stuck in `queued` | Check runner health before assuming an outage; never report unverified CI as green |
| Issue is unclear or blocked | Ask the user for clarification |
| A command in `CLAUDE.md` does not work | Report it — a stale documented command is a finding, not a detour |

## Shell Execution Rules

**Critical — follow these to avoid orphaned terminals and hung sessions:**

1. **Batch commands** — chain multiple commands in a SINGLE shell call using `&&`. Never open a new
   shell invocation per command.
   ```bash
   # CORRECT — one call
   npm run lint && npm run test && npm run build

   # WRONG — three separate calls
   npm run lint
   npm run test
   npm run build
   ```

2. **No watch mode** — never run watch or interactive commands. Always force one-shot execution.
   Test runners default to watch mode in several ecosystems; use the run-once form (`--run`,
   `--watch=false`, `CI=1`) and check what the project's script actually does before trusting it.

3. **No background processes** — never use `&`, `nohup` or `disown`. Dev servers and hot-reloading
   application servers are long-running and never belong in a gate.

4. **No interactive sessions** — never launch a REPL (`node`, `python`, `psql`, `sqlite3` without
   `-c`). Use the one-shot flag form.

5. **Prefer a non-interactive execution subagent** when you need to run a command and read its
   output to make a decision, where one is available. It always exits.

6. **CI quality gate** — run the project's gate as one batched call per toolchain. A repository with
   two toolchains is two calls; run only the side(s) your change touches, and both if it touches
   both. `CLAUDE.md` names the real commands. The table below is the *shape*, not the commands:

   | Ecosystem | Batched gate (example only) |
   |---|---|
   | Node | `npm run lint && npm run test && npm run build` |
   | Python | `python -m pytest -q && python -m ruff check <changed files> && python -m mypy <changed files>` |
   | Go | `go vet ./... && go test ./... && go build ./...` |
   | Rust | `cargo clippy -- -D warnings && cargo test && cargo build` |

   Two details worth establishing once per repository, because both bite silently: a build script
   may also *be* the typecheck (the type checker chained ahead of the bundler), so skipping the
   build skips type checking entirely; and a project virtual environment may need its interpreter
   invoked explicitly as `<env>/bin/python -m <tool>` rather than the tool's console script, because
   a bare tool name can resolve to a system install that lacks the project's dependencies and fails
   in a way that reads like the tool is missing.

## Prerequisites

- Git configured with push access to the repository
- GitHub CLI (`gh`) installed and authenticated — this is the GitHub interface, not a fallback
- The project's test runner and linter installed and runnable
- `CLAUDE.md` / `AGENTS.md` read, or the commands inferred and reported
