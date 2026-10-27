---
name: code-issue
description: Autonomous senior developer workflow for resolving one GitHub issue per pull request in any repository. Reads the project's own rules first, then runs test-driven development with mutation-verified tests, security scanning, branch and PR automation, CI validation and self-review. Holds an 80% coverage floor on touched code unless the project names its own.
argument-hint: "[issue number] — GitHub issue number to resolve"
---

# Code Issue Resolver

Resolve **one GitHub issue per branch and PR** with test-first development, a security scan, CI
to green and a self-reviewed PR. Nothing here assumes a language, package manager, layout or CI
provider: everything project-specific comes from the project. When several issues are given, work
them one at a time, each to its own green PR.

## Step 0: The project's rules come first

The project's `CLAUDE.md` is already in your context — do not re-read it. It is the authority
on the exact build / test / lint commands, coverage floors, the changelog convention, protected
paths and data-handling rules; where it and this document disagree, the project wins, and the
numbers here are defaults for a repository that names none. If the repository has an
`AGENTS.md` and no `CLAUDE.md`, read `AGENTS.md`. **`.claude/delivery.md`**, if it exists, holds
delivery-pipeline constraints such as branch naming, PR body shape and which gates block a merge.
Step 1's batched call reads both, so do not spend a separate turn on either.

If the repository has neither file, or the project states no commands, infer them from the repository — `package.json` scripts,
`Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, and above all the CI workflow under
`.github/workflows/` — and **say in your report what you inferred**. An inferred command
presented as a known one is how a "green" report gets made from a suite that never ran.

### Step 1: Planning

Orientation takes **two turns**: every separate fetch is a full model turn over a growing context.

1. **One batched Bash call** reads the issue, the project's delivery rules and the CI layout:
   ```bash
   for n in {numbers}; do gh issue view $n --json title,body,labels,comments; done; \
   echo '=== DELIVERY'; cat .claude/delivery.md 2>/dev/null; \
   echo '=== AGENTS'; \
   [ -f CLAUDE.md ] || cat AGENTS.md 2>/dev/null; \
   echo '=== CI'; ls .github/workflows 2>/dev/null; \
   gh repo view --json defaultBranchRef
   ```
   The parts are joined with `;`, not `&&`, so a missing file does not abort the rest.
2. **One response of parallel reads.** In a single response, read any linked issues (to learn
   the boundaries of this one), the CI workflow and the source files the issue names, as parallel
   tool calls.
3. Look up library and API documentation you are unsure about. Do not guess an API signature you
   can check.
4. Match the patterns and conventions the surrounding code already follows.

### Step 2: Branch Setup

Start from a clean tree on the up-to-date default branch (`gh repo view --json defaultBranchRef`),
create `feature/issue-{number}-{short-description}` unless the project names its own convention,
and push it with `git push -u origin {branch}`. Always name the remote explicitly: a repository
may carry remotes that are not push targets.

**If the checkout may be shared with another session, do not `git checkout` in it** — a branch
switch under another agent moves its HEAD mid-task. Create your own worktree (`git worktree add`)
and remove it when you are done.

### Step 3: Implementation

#### 3a. Test-Driven Development

- Write failing unit tests that verify the expected behavior, then implement the minimum code that
  makes them pass.
- **A test that cannot fail is not a test.** Verify each meaningful test by mutating the
  implementation — invert a condition, delete a write, return a constant, skip the persist — and
  watch the test go red. Then restore. **List the mutations you performed and what went red in the
  PR body.**
- Run the project's coverage command — `CLAUDE.md` names it. Aim for **at least 80% on the code you
  touched**. If the project states its own floor, that number wins, including when it is lower than
  80: floors are often a ratchet set from a measurement. Raise a floor in the same PR when your work
  clears a higher number, and give a reason in the PR body when you lower one.
- **The gate is the command's exit code, not your reading of the summary table.** Run the form
  that enforces the floor.
- **Check whether CI actually runs that gate on pull requests.** If it is skipped on PRs, run it
  locally before opening the PR; `gh workflow run <workflow>.yml --ref <branch>` checks a branch on
  demand.
- This is a **hard gate** — do not proceed to delivery with the suite or the floor failing.

#### 3b. Defect shapes worth hunting

- **A write that reports success while the read cannot see it** — the wrong storage (memory, or a
  cache the reader never consults), the wrong layer (a projection the query path does not read),
  the wrong time (after the read, or in a transaction that never commits), or the wrong harness (the
  test asserts against the object it just built). Assert by reading back through the path a real
  consumer uses.
- **A scoped query that matches on the entity id without the scoping column.** Tenant-, project- or
  user-scoped data must filter on the scope *and* the id; this passes every single-tenant test.
- **State that nothing reads.** New state needs a consumer that actually reads it.
- **An endpoint with no consumer.** Wire at least one real caller, or say in the PR that it ships
  unconsumed.

#### 3c. Lint and Format

- Run the project's linter and formatter as `CLAUDE.md` names them, **scoped to the files you
  changed** when the tree carries pre-existing findings. A new finding in a file you touched is
  yours; greening the whole repository is not this change's job.
- **Do not reformat files you did not come to change.** Fix your own warnings; do not suppress them.

#### 3d. Self-Review Checklist

- [ ] No unused variables or imports, no hardcoded secrets, no unresolved TODO/FIXME
- [ ] Code follows existing project conventions; error handling at system boundaries
- [ ] Tests cover happy path, edge cases and error cases — and each was seen to fail
- [ ] Scoped queries filter on the scoping column, not just the entity id
- [ ] Schema changes carry a migration with a *working* rollback
- [ ] Changelog and living documents handled (Step 5.5)

#### 3e. UI Consideration

If the issue involves UI changes:

- When invoked interactively, ask the user: *"This issue includes UI changes. Would you like me to
  create Playwright e2e tests?"* When dispatched, do not ask: decide from the issue's acceptance
  criteria and say in the PR body whether e2e tests are recommended.
- If they are wanted, hand off to the **`delivery:e2e-test`** agent, or run `/delivery:e2e-test`
- For live visual verification of a running app, hand off to **`delivery:ui-vision`**. Those two are
  the only agents that use Playwright MCP tools; this skill does not.

### Step 4: Security Scan

Before creating the PR, perform a security review of your own change.

**Security blocking rule** (stated in `skills/code-issue/SKILL.md` Step 4; every other copy
quotes it word for word): a `critical` or `high` security finding blocks the PR. A `medium`
one is a follow-up, and blocks only if it is exploitable in the changed code; say which.
`low` and `nit` never block. Dependency audits run at `--audit-level=high`. The severity
scale is `critical | high | medium | low | nit`, the same words as the review's structured output.

1. **Dependency audit** — run the ecosystem's audit command (`npm audit --audit-level=high`,
   `pip-audit`, `cargo audit`, `govulncheck ./...`), starting with the dependencies **you added or
   bumped**.
2. **CVE lookup** — read the full record of any advisory the audit returns before acting on it.
3. **Severity gate** — apply the security blocking rule above. As a guide, CVSS 9.0+ is
   `critical`, 7.0–8.9 `high`, 4.0–6.9 `medium`.
4. **Static review of changed files** — injection (SQL/NoSQL/OS command/LDAP), XSS, CSRF, insecure
   deserialization, path traversal, hardcoded credentials, weak crypto, and the rest of the OWASP
   Top 10.
5. **Report and fix** — fix what blocks, re-run the tests, and report every finding with severity.

### Step 5: CI Validation

1. Find the CI configuration (`.github/workflows/`, `.gitlab-ci.yml`, `Jenkinsfile`).
2. Run the equivalent gate locally, batched, before pushing.
3. Verify: tests pass, linter clean on changed files, typecheck/build clean, coverage floor held.
4. After pushing, wait for the remote run with **one bounded blocking call**, and give the Bash
   tool an explicit `timeout` of at most `600000` ms:
   ```bash
   gh pr checks {number} --watch --fail-fast --interval 30 >/dev/null 2>&1; gh pr checks {number} --json name,bucket
   ```
   Only the compact JSON reaches your context. Do not poll in a loop, and do not raise the timeout
   casually: a dispatched subagent's prompt cache lives about 5 minutes.
   **If the timeout fires with checks still pending**, run `gh pr checks {number} --json name,bucket`
   once more. If any `bucket` is still `pending`, report CI as **not verified**, never as passed.
   **If any `bucket` is `fail`** (the usual result of `--fail-fast`), read the failing job's log
   with `gh run view <run-id> --log-failed`, fix the cause, push, and wait again with the same
   bounded call. **If `gh pr checks` says `no checks reported`**, the repository runs no CI on
   pull requests: report CI as **not configured / not verified**, never as passed, and rely on
   the local gate from item 2.
5. **A job stuck in `queued` is ambiguous** — a deep queue and a runner outage look identical.
   Check runner health (`gh api repos/<owner>/<repo>/actions/runners`), or ask when interactive.
   Never report CI as verified when it never ran.

### Step 5.5: Update Living Documents

Before creating the PR, update the changelog (per the project's convention; prefer a per-PR
fragment where the project uses them, and never bump a version unless the project says so),
architecture and user documentation, and — only when navigation or build changes — the
agent-instruction file. Skip any document that does not exist. For the rules on each, read
`${CLAUDE_PLUGIN_ROOT}/skills/code-issue/LIVING_DOCS.md` whenever the change is user-facing,
architectural, adds configuration, or would touch `CLAUDE.md` / `AGENTS.md`.

### Step 6: Delivery

1. Stage explicit paths with `git add <paths>` — never `git add -A`, never files `CLAUDE.md` marks
   as protected, and never `git add -f` past an ignore rule.
2. Commit with a conventional message: `feat: [Issue #N] description` or `fix: [Issue #N] description`
3. Push the branch to the origin remote
4. Create the PR with `gh pr create --body-file <file>`:
   - Title: `feat: Resolve #{issue-number} — {description}`
   - Body: summary of changes; `Closes #N`; the coverage numbers; the mutations you used to prove
     the tests can fail; the security scan result; **Defects found**; and **Deferred** (anything in
     scope you left undone, with the reason). The reviewer reads the PR body, not your report.
5. Add inline review comments on your own diff wherever a reviewer will want the reasoning. You
   cannot approve your own PR.

### Step 7: Handoff

If a workflow or another agent dispatched you, skip this step: your report or structured output
is the handoff. Otherwise present the PR link, the issue it closes, coverage (and the floor it was
measured against), the mutations and what went red, the security result, and any inferred
commands.

For a full implement → review → fix → re-review loop, hand the work to **`delivery:orchestrator`**
rather than driving the phases by hand.

## Fix mode

A dispatch that says **Fix mode** is fixing review findings on a PR that already exists. It is
not a new implementation, so most of the workflow above does not apply:

- **Work on the existing PR branch.** The prompt names it (`headRefName`). Check it out and push
  to it. If you are in an isolated worktree, use `gh pr checkout <number> --detach` and push with
  `git push origin HEAD:<headRefName>`.
- **Create no new branch and no new PR.** Do not edit the PR's title or body beyond noting the
  fixes.
- **Address only the listed findings.** Every blocking finding gets a fix and a test you saw fail
  without it (Step 3a's mutation rule applies). Each non-blocking finding is either taken or
  declined with a reason. Do not widen the change.
- **Run the project's test and lint gates** (Step 3a and 3c) on what you changed, and wait for CI
  as Step 5 describes.
- **Skip** Step 1's issue planning, Step 2 (branch setup), the full Step 4 security scan (review
  only the lines you changed), Step 5.5 (living documents), Step 6's PR creation and Step 7.
- **Report** in the structured fix output the dispatch asks for: each finding changed, with its
  test; each declined, with the reason; and whether the gates passed and the fixes are pushed.

## Error Recovery

| Scenario | Action |
|----------|--------|
| Resuming a branch that has fallen behind the default branch | Read `${CLAUDE_PLUGIN_ROOT}/skills/code-issue/MERGE_CONFLICTS.md` and follow it |
| `gh` push or PR creation fails | Check `gh auth status`; retry; fall back to the branch compare URL |
| Tests fail after implementation | Debug, fix, re-run — never weaken an assertion to make it pass |
| CI job fails | Read the logs (`gh run view --log-failed`), fix, re-run |
| Issue is unclear or blocked | Interactive: ask the user for clarification. Dispatched: decide from the acceptance criteria and record the decision, or report it blocked and why |
| A command in `CLAUDE.md` does not work | Report it — a stale documented command is a finding, not a detour |

## Shell Execution Rules

Digest; the full rules, with examples, are in `${CLAUDE_PLUGIN_ROOT}/skills/code-issue/SHELL_RULES.md`
— read it before your first gate run if you have not already.

1. **Batch** dependent commands in one shell call joined with `&&`; the read-only orient batch in
   Step 1 is joined with `;` on purpose.
2. **No watch mode** — use the run-once form (`--run`, `--watch=false`, `CI=1`). The only exception
   is the bounded `gh pr checks` wait in Step 5, with a Bash `timeout` of at most `600000` ms.
3. **No background processes** (`&`, `nohup`, `disown`) and **no interactive sessions** (REPLs).
4. **Run the CI gate as one batched call per toolchain**, only for the side(s) your change touches.
5. **Keep output small** — quiet reporters, `tail -n 60` or a `grep` for failures.
