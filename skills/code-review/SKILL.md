---
name: code-review
description: Comprehensive code review workflow for pull requests in any repository. Validates the PR against its linked requirements, then reviews design, security (OWASP Top 10), performance, test quality and documentation, and publishes a structured GitHub review with inline comments via the gh CLI.
argument-hint: "[PR number] — e.g. 'review PR #47' or 'review PR #47 against epic #12'"
---

# Code Review

Review one pull request against its linked requirements, security, correctness, tests and — on a
full review — design, performance and documentation, then publish a structured GitHub review with
inline comments. Nothing here assumes the repository's language, layout or toolchain.

## Step 0: The project's rules come first

The project's `CLAUDE.md` is already in your context — do not re-read it. Review against it:
reviewing against invented standards produces confident findings that are wrong, which is worse
than no review. If the repository has an `AGENTS.md` and no `CLAUDE.md`, read `AGENTS.md`.
**`.claude/delivery.md`**, if it exists, is often where the blocking-versus-advisory line is drawn.
Step 1's batched call reads it, along with `AGENTS.md`, so do not spend a separate turn on either.

If the repository has neither file, or states no commands or conventions, infer them from the repository — package
manifests, `Makefile`, the CI workflow — and **say in the review what you inferred**. A finding
that rests on an inferred standard must be labelled as such, not asserted as a rule.

## Tools

The reviewer holds `Read`, `Bash` and `Skill`, with `Write` and `Edit` disallowed: it reads the
repository, runs commands (the project's gates, `gh`), and has **no web tools**. For a dependency the PR added or bumped, read its advisories with the ecosystem's audit
command (`npm audit --json`, `pip-audit`, `cargo audit`, `govulncheck`) or GitHub's database
(`gh api "/advisories?affects=<package>@<version>"`), not a web search.

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
   - on a full review, **every changed file, in full**, not just the diff hunks. Context matters,
     and the defects that matter most are usually visible only in the part the diff did not touch.
     (A light review reads the diff plus only the changed files it needs, as its scope note says);
   - the project's own documentation that bears on the change: architecture notes, specs, user
     guides. Wherever they live in this repository; do not assume a `docs/` directory exists.
3. **Read CI from the batch.** Failing CI is blocking. CI that is still running or stuck in
   `queued` is not the PR's fault — a deep queue and a runner outage look identical from
   `gh pr checks`, so say which it is (or that you could not tell) rather than reporting a red
   check.

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

### Step 3: Design Review (full review only)

On a full review, read `${CLAUDE_PLUGIN_ROOT}/skills/code-review/FULL_REVIEW_STEPS.md` now and run its Step 3 (design), Step 6 (performance) and
Step 8 (documentation) at their places in this sequence. A light review skips all three and says
so in its "Scope of this review" section.

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

**Security blocking rule** (stated in `skills/code-issue/SKILL.md` Step 4; every other copy
quotes it word for word): a `critical` or `high` security finding blocks the PR. A `medium`
one is a follow-up, and blocks only if it is exploitable in the changed code; say which.
`low` and `nit` never block. Dependency audits run at `--audit-level=high`. The severity
scale is `critical | high | medium | low | nit`, the same words as the review's structured output.

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

### Step 6: Performance Review (full review only)

In `${CLAUDE_PLUGIN_ROOT}/skills/code-review/FULL_REVIEW_STEPS.md`.

### Step 7: Test Review

**Goal:** Verify tests are correct, meaningful and sufficient. This is where reviews earn their
keep, because a green suite is not evidence.

| Check | Question |
|-------|----------|
| **Coverage** | Are the new code paths covered? Target at least 80% on touched code — unless `CLAUDE.md` names its own floor, which wins |
| **Can it fail?** | **A test that cannot fail is not a test.** Did the author state which mutations they made and what went red? If not, mutate the implementation yourself and confirm the test catches it. Restore every mutation and leave `git status --short` clean |
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

### Step 8: Documentation Review (full review only)

In `${CLAUDE_PLUGIN_ROOT}/skills/code-review/FULL_REVIEW_STEPS.md`.

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

A reused scratch file from an earlier session publishes a *previous PR's* inline comments against
this PR. It surfaces as repeated `422 Path could not be resolved`, one per *stale* comment, which
reads like a line-number bug in your own payload. A fresh `mktemp -d` path plus the `jq` read-back
rules it out.

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

**What makes a finding blocking** (→ `do not merge`): failing CI; a security finding that the
security blocking rule (Step 4) says blocks; missing requirements; broken or unfalsifiable tests; undocumented architectural
change; a missing changelog entry on a user-facing change. Everything else is a follow-up or a nit.

**Report only what this PR introduced**: not pre-existing issues in unchanged code, nor lint or
type findings. Rate each finding's `confidence` (0-100) that it is real; the workflow drops only
low-confidence non-blocking ones.

**Say who can clear each blocking finding** (`resolvableBy`): `author`, a change to this PR;
`owner`, only a person (an approval the issue requires, a check on a real device); `wait`, only
time (CI still running, an outage). A fix pass runs only for `author`; never soften a real defect
into `owner`. Report the commit you read as `headSha` (`gh pr view {PR_NUMBER} --json headRefOid`).

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

## Review Comment Style Guide

After Google's engineering-practices guidance on review comments:

- **Be kind and explain why.** Critique the code, not the person; say what is better, and why.
- **Prefix nits** with `nit:`, and **give credit** where something is done well.
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
| Too many files to review | Prioritize non-generated, non-config files; state in the review what was not read |
| Cannot determine coverage | Run the project's coverage command; if it will not run, say so rather than implying a number |

## Shell Execution Rules

Digest; the full rules, shared with code-issue, are in
`${CLAUDE_PLUGIN_ROOT}/skills/code-issue/SHELL_RULES.md`.

1. **Batch** dependent commands in one shell call joined with `&&`; the read-only orient batch in
   Step 1 is joined with `;` on purpose.
2. **No watch mode** — use the run-once form (`--run`, `--watch=false`, `CI=1`).
3. **No background processes** (`&`, `nohup`, `disown`) and **no interactive sessions** (REPLs).
4. **Verify the PR's own gate** as one batched call per toolchain, only for the side(s) the PR
   touches; a build script may also be the typecheck.
5. **Keep output small** — quiet reporters, `tail -n 60` or a `grep` for failures.
