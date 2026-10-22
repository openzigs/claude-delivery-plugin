---
name: code-review
description: Comprehensive code review workflow for pull requests in any repository. Validates the PR against its linked requirements, then reviews design, security (OWASP Top 10), performance, test quality and documentation, and publishes a structured GitHub review with inline comments via the gh CLI. Optionally hands off for fixes.
argument-hint: "[PR number] — e.g. 'review PR #47' or 'review PR #47 against epic #12'"
---

# Code Review

## Purpose

This skill drives the **Code Review** agent through a structured, multi-dimensional review of a pull request. It goes beyond surface-level linting — it validates the PR against the original requirements, checks for OWASP security issues, evaluates performance characteristics, verifies that the tests could actually fail, and assesses code design. The review is published as a formal GitHub PR review with inline comments.

It assumes nothing about the repository's language, layout or toolchain. Everything project-specific is read from the project, not guessed.

Inspired by [Google's Engineering Practices](https://google.github.io/eng-practices/review/reviewer/looking-for.html) and the [OWASP Code Review Guide](https://owasp.org/www-project-code-review-guide/).

## When to Use

- A PR is ready for review and the user asks "review PR #N"
- The user wants a pre-merge quality gate before approving
- After an implementation agent creates a PR and before the user merges
- The user asks to "check if PR #N meets the requirements for issue #M"
- As a handoff target from the Code Issue agent's delivery step

## Step 0: The project's rules come first

The project's `CLAUDE.md` is already in your context — do not re-read it. Review against it:
reviewing against invented standards produces confident findings that are wrong, which is worse
than no review. If the repository has an `AGENTS.md` and no `CLAUDE.md`, read `AGENTS.md`.
**`.claude/delivery.md`**, if it exists, is often where the blocking-versus-advisory line is drawn.
Step 1's batched call reads it, along with `AGENTS.md`, so do not spend a separate turn on either.

If the project states no commands or conventions, infer them from the repository — package
manifests, `Makefile`, the CI workflow — and **say in the review what you inferred**. A finding
that rests on an inferred standard must be labelled as such, not asserted as a rule.

## Agent and tools

Execute with the **`delivery:code-review`** agent — the same reach as `delivery:code-issue`, but a
reviewer's posture: read-heavy, comment-focused, and it does not modify code unless asked.

GitHub work is done with the **`gh` CLI**. It is always available and authenticates independently.
**MCP servers are optional and may be absent — never make a step depend on one.** Every command in
Step 9 is `gh`, deliberately.

The reviewer has **no web tools**: everything a review needs is in the repository, the PR and
GitHub. For a dependency the PR added or bumped, read its advisories with the ecosystem's audit
command (`npm audit --json`, `pip-audit`, `cargo audit`, `govulncheck`) or GitHub's database
(`gh api "/advisories?affects=<package>@<version>"`), not a web search.

## Workflow Overview

```
┌───────────────────────────────────────────────────────┐
│  0. RULES — The project's rules come first            │
├───────────────────────────────────────────────────────┤
│  1. ORIENT — Read PR, linked issues, and project docs │
├───────────────────────────────────────────────────────┤
│  2. REQUIREMENTS — Validate completeness against spec │
├───────────────────────────────────────────────────────┤
│  3. DESIGN — Evaluate architecture and design choices │
├───────────────────────────────────────────────────────┤
│  4. SECURITY — OWASP Top 10 + dependency advisories   │
├───────────────────────────────────────────────────────┤
│  5. QUALITY — Code quality, complexity, naming, style │
├───────────────────────────────────────────────────────┤
│  6. PERFORMANCE — Identify bottlenecks and anti-pats  │
├───────────────────────────────────────────────────────┤
│  7. TESTS — Coverage, can-they-fail, edge cases       │
├───────────────────────────────────────────────────────┤
│  8. DOCUMENTATION — Inline docs, README, changelog    │
├───────────────────────────────────────────────────────┤
│  9. PUBLISH — Submit the GitHub review                │
├───────────────────────────────────────────────────────┤
│  10. HANDOFF — Offer to fix the findings              │
└───────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Orient

**Goal:** Build a complete mental model before reviewing any code. Orientation takes **two
turns**: every separate fetch is a full model turn over a growing context.

1. **One batched Bash call** fetches the PR, its changed files, the diff, CI and the project's
   delivery rules together:
   ```bash
   gh pr view {PR_NUMBER} --json title,body,author,baseRefName,headRefName,reviews,files; \
   echo '=== DIFF'; gh pr diff {PR_NUMBER}; \
   echo '=== CHECKS'; gh pr checks {PR_NUMBER} 2>&1; \
   echo '=== DELIVERY'; cat .claude/delivery.md 2>/dev/null; \
   echo '=== AGENTS'; \
   [ -f CLAUDE.md ] || cat AGENTS.md 2>/dev/null
   ```
   The parts are joined with `;`, not `&&`, so one failing part does not abort the rest: a
   missing `.claude/delivery.md` prints nothing, and a PR with no checks prints a message and a
   non-zero exit that you ignore. From the output, extract `Closes #N` / `Fixes #N` references, the
   author, previous reviews and the list of changed files.
2. **One response of parallel reads.** In a single response, issue every remaining read as a
   parallel tool call:
   - the linked issue(s)/epic, `gh issue view {N} --json title,body,labels,comments`: acceptance
     criteria, definition of done, sub-issue scope and boundaries, labels;
   - **every changed file, in full**, not just the diff hunks. Context matters, and the defects
     that matter most are usually visible only in the part the diff did not touch;
   - the project's own documentation that bears on the change: architecture notes, specs, user
     guides. Wherever they live in this repository; do not assume a `docs/` directory exists.
3. **Read CI from the batch.** Failing CI is blocking. A job stuck in `queued` is not the PR's
   fault — a deep queue and a runner outage look identical from `gh pr checks`, so say which it is
   (or that you could not tell) rather than reporting a red check. Do **not** report pre-existing
   lint or type findings as PR findings.

### Step 2: Requirements Validation

**Goal:** Ensure the PR delivers what was asked for — no more, no less.

| Check | Question |
|-------|----------|
| **Completeness** | Does the PR address ALL acceptance criteria from the issue? |
| **Scope creep** | Does the PR include changes NOT described in the issue? |
| **Sub-issues** | If this is part of an epic, are all assigned sub-issues covered? |
| **Edge cases** | Did the issue mention edge cases? Are they handled? |
| **Backwards compat** | Does this change break any existing API or behavior? |
| **Unrelated reformatting** | Are files reformatted that the change had no reason to touch? That is diff noise and a finding in its own right. |

**Output:** a list of requirements with pass/fail status. Flag every gap.

### Step 3: Design Review

**Goal:** Evaluate high-level architecture and design decisions.

Based on [Google's design review criteria](https://google.github.io/eng-practices/review/reviewer/looking-for.html#design):

- **Does this change belong here?** Or should it live in a library, another module, or configuration?
- **Integration:** does it fit the existing architecture, or fight it?
- **Abstractions:** are the right ones used? Too many layers? Too few?
- **Coupling:** does this introduce tight coupling between modules?
- **Single Responsibility:** does each new class/function/module do one thing?
- **Over-engineering:** unnecessary generalization or premature abstraction?
- **Patterns:** does it follow existing patterns, or introduce new ones without justification?
- **Consumers:** does anything actually *use* what this adds? An endpoint with no caller and a store
  field nothing renders from are both untested-by-construction. Building an endpoint's first
  consumer is when its defects surface, so an unconsumed one should be called out as unproven.

Verify library APIs against real documentation rather than memory when the usage looks unusual.

### Step 4: Security Review (OWASP Focus)

**Goal:** Identify security vulnerabilities before they reach production.

Scan all changed files for these OWASP Top 10 categories:

| OWASP Category | What to Look For |
|----------------|------------------|
| **A01: Broken Access Control** | Missing auth checks, IDOR, privilege escalation, CORS misconfig |
| **A02: Cryptographic Failures** | Hardcoded secrets, weak algorithms (MD5, SHA1), missing TLS, plaintext storage |
| **A03: Injection** | SQL injection, NoSQL injection, OS command injection, LDAP injection, XSS |
| **A04: Insecure Design** | Missing rate limiting, no input validation at trust boundaries, business logic flaws |
| **A05: Security Misconfiguration** | Debug mode enabled, default credentials, unnecessary features exposed, verbose errors |
| **A06: Vulnerable Components** | Known advisories in dependencies the PR added or bumped |
| **A07: Auth Failures** | Weak passwords allowed, missing MFA, session fixation, token leakage in logs/URLs |
| **A08: Data Integrity Failures** | Insecure deserialization, unsigned updates, CI/CD pipeline manipulation |
| **A09: Logging Failures** | Missing audit logs for sensitive operations, secrets or personal data in logs, no alerting |
| **A10: SSRF** | Unvalidated URLs from user input used in server-side requests |

**Additional checks:**

- **Scope and tenancy:** every scoped query filters on the scoping column, not just the entity id. A
  query that matches an id alone lets one tenant's record satisfy another tenant's check, and it
  passes every single-tenant test.
- No `eval()`, no `innerHTML` with untrusted input, no raw-HTML injection API without sanitization
- External links using `target="_blank"` carry `rel="noopener noreferrer"`
- No secrets committed — check env files, config, fixtures, and test data
- Path traversal protection on file operations
- CSRF tokens on state-changing requests
- No protected or ignored paths added to the repository — some projects ignore paths because
  publishing them cannot be undone by a later commit. A PR that forces past an ignore rule is
  blocking regardless of content.

**Severity ratings:** Critical / High / Medium / Low / Informational.

### Step 5: Code Quality

| Dimension | What to Check |
|-----------|---------------|
| **Complexity** | Can each function be understood quickly? Is anything over-engineered? |
| **Naming** | Are variables, functions and classes named clearly and consistently? |
| **Comments** | Do comments explain *why*, not *what*? Are there stale comments? |
| **Style** | Does the code follow the project's lint config and conventions? |
| **Consistency** | Does new code match existing patterns? |
| **DRY** | Is there duplicated logic that should be extracted? |
| **Error handling** | Are errors caught at system boundaries? Are the messages useful? |
| **Dead code** | Unused variables, imports, unreachable branches? |
| **Magic values** | Hardcoded numbers/strings that should be named constants? |

**Judge lint findings by what the PR touched.** In a tree with pre-existing findings, a whole-repo
lint run is not evidence about this change. A new finding in a file the PR touched is the author's;
the rest is not this PR's job.

### Step 6: Performance Review

| Pattern | What to Look For |
|---------|------------------|
| **N+1 queries** | Database calls inside loops |
| **Unbounded queries** | Full-table reads without a limit, missing pagination |
| **Memory leaks** | Event listeners not cleaned up, unclosed resources, growing caches |
| **Bundle size** | Large dependencies pulled in for a small feature |
| **Unnecessary re-renders** | Component memoization missing where it demonstrably matters |
| **Blocking operations** | Synchronous I/O on a request or UI thread, long computations without workers |
| **Missing caching** | Repeated expensive computation without memoization |
| **Regex backtracking** | Patterns that can degrade catastrophically (ReDoS) |

### Step 7: Test Review

**Goal:** Verify tests are correct, meaningful and sufficient. This is where reviews earn their
keep, because a green suite is not evidence.

| Check | Question |
|-------|----------|
| **Coverage** | Are the new code paths covered? Target at least 80% on touched code — unless `CLAUDE.md` names its own floor, which wins |
| **Can it fail?** | **A test that cannot fail is not a test.** Did the author state which mutations they made and what went red? If not, ask — or mutate the implementation yourself and confirm the test catches it |
| **Read-back assertions** | Does the test assert by reading through the same path a real consumer uses, or does it assert against the object it just constructed? The latter cannot detect a write that never landed |
| **Happy path** | Do tests verify the primary use case? |
| **Edge cases** | Empty inputs, nulls, boundary values, large inputs? |
| **Error cases** | Are failure modes and error handling exercised? |
| **Test quality** | Are assertions specific? Are the names descriptive? |
| **Isolation** | Are unit tests isolated from external dependencies? |
| **Missing tests** | Are there code changes with no corresponding test changes? |

The dominant defect shape to hunt in the tests is **a write that reports success while the read
cannot see it** — wrong storage, wrong layer, wrong time (never committed), or wrong harness (the
test never re-read). Ask of each persistence test: what would this catch if the write were deleted?

Two more shapes that survive a green build:

- **Green build, broken artifact.** A type-check and a bundle both succeeding says nothing about
  what loads at runtime. Where a project has chained extra verification into its build to catch
  that, a PR that unpicks the chain removes the only check between a passing build and a broken
  app — blocking.
- **A guard that cannot fire.** A validation, permission check or assertion placed where the
  condition it tests is already impossible.

### Step 8: Documentation Review

| Check | Question |
|-------|----------|
| **Inline docs** | Are public APIs documented? Are non-obvious algorithms explained? |
| **README** | If behavior changed, is the README updated? |
| **Changelog** | Does the PR follow the project's changelog convention, as `CLAUDE.md` states it? If the project uses per-PR fragments, the PR should add a fragment rather than edit the shared CHANGELOG — a PR editing the shared file directly should be asked to move the entry. A missing entry on a user-facing change is **blocking**, but *presence is a judgment call that nothing automates*, which is why it is asked here: a tests-only or internals-only PR may legitimately carry none, and should say so. |
| **Architecture docs** | If new modules, services, endpoints or schemas were introduced, are the project's architecture docs updated — diagram nodes, project structure, endpoint contracts, tech stack table? Flag as blocking when architectural change ships undocumented. |
| **User docs** | If user-facing features, config options or CLI commands changed, is the user documentation updated? |
| **Agent-instruction file** | Did the PR add to the root `CLAUDE.md` / `AGENTS.md`? That file is injected into every agent session and re-sent every turn, so it is an index: detail, gotchas, measurements and rationale belong in a topic file, with at most a one-line pointer in the root. Flag additions of detail to the root file, "last updated" stamps, and anything that pushes it over a stated size budget (**blocking** if a budget check would fail). |
| **Migration** | If there are schema or API changes, is there a migration — with a working rollback — and a guide where consumers need one? |
| **Removed code** | If features were removed, was their documentation removed too? |

### Step 9: Publish the Review

Publish with the `gh` CLI. The mechanics below are not incidental — each one corresponds to a
failure mode that silently publishes the wrong thing, or nothing.

**1. Build the payload as a file, at a fresh, PR-unique path.**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
PAYLOAD="$(mktemp -d)/review-{PR_NUMBER}.json"
```

```json
{
  "event": "COMMENT",
  "body": "## Code Review Summary — PR #{PR_NUMBER}\n\nRecommendation: ...",
  "comments": [
    { "path": "src/example.ts", "line": 42, "side": "RIGHT", "body": "nit: ..." }
  ]
}
```

Put every finding in `comments` (one `{path, line, body}` entry each) rather than in the body —
`gh pr review` cannot post inline comments, and a review without them reads as empty.

**`event` and `body` go INSIDE the JSON passed to `--input` — never as `-f` flags.** Fields passed
as `-f` on a `POST` with `--input` land in the *query string*, where a real review body is far too
long: the request fails with **HTTP 414**, which reads like a size limit on reviews rather than a
mistake in the invocation.

**2. Read the payload back before POSTing.**

```bash
jq '{event, body_len: (.body|length), comments: (.comments|length), first: (.comments[0].path // "none")}' "$PAYLOAD"
gh api -X POST "repos/$REPO/pulls/{PR_NUMBER}/reviews" --input "$PAYLOAD"
```

A reused scratch file such as `findings.json` left over from an earlier session publishes a
*previous PR's* inline comments against this PR — and the symptom is not an obvious one: it
surfaces as repeated `422 Path could not be resolved`, once per comment, which reads like a
line-number bug in your own payload. The tell is that the error count matches the *stale* file's
comment count, not yours. A fresh `mktemp -d` path plus the `jq` read-back rules it out.

**3. Publish `"event": "COMMENT"` with a `Recommendation:` line — always.**

GitHub rejects `APPROVE` and `REQUEST_CHANGES` on your own pull request with **422 — `Can not
request changes on your own pull request`**, and in an automated pipeline the authenticated `gh`
user is usually also the PR author. More fundamentally, **no automated review is an independent
approval**, whoever the identity is. So publish `COMMENT`, open the body with a recommendation,
and leave the merge decision with a human:

- `Recommendation: merge — no blocking findings`
- `Recommendation: merge with follow-ups — N non-blocking findings`
- `Recommendation: do not merge — N blocking findings`

Follow it with one line saying this is automated analysis, not a human sign-off. **Do not write
APPROVE, REQUEST_CHANGES or "Verdict:" anywhere**, and do not work around the 422 by retrying with
a different event — writing an approval into a COMMENT defeats the control rather than
satisfying it.

**4. An empty-looking review and a clean one must not read the same.** "No inline comments" is
ambiguous — it reads identically whether you found nothing, ran out of budget, or failed to attach
the comments. If the review is genuinely clean, say what was examined and what was checked for. If
it is truncated or partial, say that instead. Never publish a review whose emptiness is unexplained.

**What makes a finding blocking** (→ `do not merge`): failing CI; any critical, high or medium
security finding; missing requirements; broken or unfalsifiable tests; undocumented architectural
change; a missing changelog entry on a user-facing change. Everything else is a follow-up or a nit.

**Review body structure:**

```markdown
## Code Review Summary — PR #{PR_NUMBER}

Recommendation: {merge | merge with follow-ups | do not merge} — {N blocking findings}

### Requirements: {PASS|PARTIAL|FAIL}
- [x] Acceptance criterion 1
- [ ] Missing: acceptance criterion 2

### Security: {CLEAN|FINDINGS}
| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | — |
| High | 1 | XSS in UserInput.tsx:42 |

### Code Quality: {GOOD|NEEDS WORK}
- Naming: good
- Complexity: 2 functions flagged
- Style: consistent with the surrounding code

### Performance: {CLEAN|FINDINGS}
- No issues found

### Tests: {SUFFICIENT|GAPS}
- Coverage: 85% on touched code, against the project's floor of 80%
- Falsifiability: author listed 3 mutations, all went red
- Missing: edge case for empty input

### Documentation: {UP TO DATE|NEEDS UPDATE}
- Changelog: present, per the project's convention
- Architecture docs: new endpoint not documented
- README: no change needed

### Scope of this review
Read all 14 changed files in full; ran the project's test and lint commands
as named in CLAUDE.md. Did not exercise the running application.
```

**Fallback**, for a body short enough to survive it and no inline comments:

```bash
gh pr review {PR_NUMBER} --comment --body-file "${PAYLOAD%.json}.md"
```

### Step 10: Handoff (Optional)

If a workflow or another agent dispatched you, skip this step: your report or structured output
is the handoff.

After publishing, offer:

> **Review published. Would you like me to hand the findings to `delivery:code-issue` for fixes?**

If yes, run `/delivery:resolve-pr-comments` with the same PR number to work through the comments
just created. For a full implement → review → fix → re-review loop, `delivery:orchestrator` owns the
sequencing.

## Review Comment Style Guide

Follow [Google's guidance on review comments](https://google.github.io/eng-practices/review/reviewer/comments.html):

- **Be kind.** Critique the code, not the person.
- **Explain why.** Do not just say "this is wrong" — say what is better, and why.
- **Prefix nits.** Use `nit:` for stylistic suggestions that are not blockers.
- **Give credit.** If something is done well, say so.
- **Be specific.** Reference the exact line and suggest a concrete alternative.
- **Prioritize.** Security > correctness > performance > style.
- **Own your uncertainty.** If a finding rests on an inferred convention rather than a documented
  one, say so in the comment. A wrong finding stated confidently costs more than it saves.

## Error Recovery

| Scenario | Action |
|----------|--------|
| Cannot read the PR diff | Fall back to `git fetch origin pull/{N}/head` and diff locally |
| No linked issue found | Review without requirements validation, and note that gap in the review |
| `422 Path could not be resolved` | The payload references files not on this branch — you are almost certainly POSTing a stale payload; re-check the file path is PR-unique, and re-read it with `jq` |
| `422` on submit with APPROVE / REQUEST_CHANGES | You are the PR author, and should have published `COMMENT` anyway — see Step 9 |
| `414` on submit | `body` was passed as `-f` and went into the query string; move it inside the `--input` JSON |
| Too many files to review | Prioritize non-generated, non-config files; state in the review what was not read |
| Cannot determine coverage | Run the project's coverage command; if it will not run, say so rather than implying a number |
| No project documentation exists | Skip the documentation cross-reference and note it in the review |

## Example Invocations

```
/delivery:code-review 47
```

```
Review PR #23 against the requirements in epic #12
```

```
Do a security-focused review of PR #55
```

```
Check if PR #31 is ready to merge
```

## Shell Execution Rules

**Critical — follow these to avoid orphaned terminals and hung sessions:**

1. **Batch commands** — chain multiple commands in a SINGLE shell call using `&&`, so a failure stops
   the chain. The one exception is the read-only orient batch in Step 1, joined with `;` on purpose
   so a missing file does not abort the rest. Never open a new shell invocation per command.
   ```bash
   # CORRECT — one call
   npm run lint && npm run test && npm run build

   # WRONG — three separate calls
   npm run lint
   npm run test
   npm run build
   ```

2. **No watch mode** — never run watch or interactive commands. Always force one-shot execution
   (`--run`, `--watch=false`, `CI=1`), and check what the project's script actually does before
   trusting it to exit.

3. **No background processes** — never use `&`, `nohup` or `disown`. Dev servers and hot-reloading
   application servers are long-running and never belong in a review gate.

4. **No interactive sessions** — never launch a REPL (`node`, `python`, `psql`, `sqlite3` without
   `-c`). Use the one-shot flag form.

5. **Prefer a non-interactive execution subagent** when you need to run a command and read its
   output to make a decision, where one is available. It always exits.

6. **Verifying the PR's own gate** — when you re-run the project's checks to test the author's
   claims, run them as one batched call per toolchain, and only for the side(s) the PR touches.
   `CLAUDE.md` names the real commands; the table below is the *shape*, not the commands:

   | Ecosystem | Batched gate (example only) |
   |---|---|
   | Node | `npm run lint && npm run test && npm run build` |
   | Python | `python -m pytest -q && python -m ruff check <changed files> && python -m mypy <changed files>` |
   | Go | `go vet ./... && go test ./... && go build ./...` |
   | Rust | `cargo clippy -- -D warnings && cargo test && cargo build` |

   One detail decides whether a gate is authoritative: a build script may also *be* the typecheck,
   in which case a PR that skipped the build skipped type checking entirely.

7. **Keep command output small.** Every line a command prints stays in your context and is re-sent
   on every later turn, so one noisy test run can cost more than the rest of the review put
   together. Run tests with a quiet or summary reporter (`--reporter=dot`, `-q`, `--silent`,
   `--quiet`), and pipe long output through `tail -n 60` or a `grep` for failures — then re-run only
   the failing test, verbosely, if you need its detail. Never print a whole build log, coverage
   table or lockfile diff to read one line of it.

## Prerequisites

- GitHub access to read PRs and create reviews
- GitHub CLI (`gh`) installed and authenticated — this is the review interface, not a fallback
- `jq` available, for reading back the review payload before POSTing
- The project's test runner installed, to verify coverage claims rather than repeat them
- `CLAUDE.md` / `AGENTS.md` read, or the conventions inferred and labelled as inferred
