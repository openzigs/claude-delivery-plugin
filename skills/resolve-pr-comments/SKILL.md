---
name: resolve-pr-comments
description: Fetch, triage, and fix unresolved PR review comments. Reads comment threads, validates each against code context and best practices, applies fixes, pushes, and resolves threads via the GitHub API. Works as a sub-workflow of the code-issue agent after a PR has been reviewed.
argument-hint: "[PR number] — e.g. 'resolve comments on PR #47'"
---

# Resolve PR Review Comments

## Purpose

This skill processes **unresolved review comments** on a pull request, fixes valid issues,
pushes the fixes, and resolves the comment threads — all autonomously. It is a durable,
multi-phase workflow that integrates with the `delivery:code-issue` agent's branching and
testing conventions.

## Per-Project Constraints

**The project's `CLAUDE.md` is normally already in your context; read it only if it is not (or
`AGENTS.md` when there is no `CLAUDE.md`), and obey it exactly.** That is where
a project states its own hard rules: the exact build/test/lint commands, coverage floors,
changelog convention, protected paths, branch and commit conventions. If `.claude/delivery.md`
exists, read it too — it carries constraints aimed specifically at this delivery pipeline.

Neither file existing is fine. Infer the conventions from the repo (manifest scripts, CI
workflow, existing test layout) and **say what you inferred** in your final report, so the
user can correct you cheaply.

This matters more here than almost anywhere else in the pipeline: a reviewer's comment is an
instruction from a person, and the project's documented rules are an instruction from the
repo. When they conflict — a reviewer asks for a change the project's conventions forbid —
that is a `disagree` triage outcome, not a silent choice between them.

## When to Use

- A reviewer has left comments on your PR and you want to address them
- The user says "fix PR comments", "resolve review comments on PR #N", or "address feedback"
- After getting a "changes requested" review on a pull request
- As a handoff step from the `delivery:code-review` agent after it identifies issues

## Agent

Execute with the **`delivery:code-issue`** agent.

## Tools

All GitHub work uses the **`gh` CLI** — it is always available, authenticates independently
of any MCP server, and reaches both the REST and GraphQL APIs (`gh api`, `gh api graphql`).
Thread-level resolution state is **only** exposed by GraphQL, so `gh api graphql` is not a
fallback here; it is the primary mechanism.

| Need | Tool |
|------|------|
| PR metadata, diff, checks | `gh pr view`, `gh pr diff`, `gh pr checks` |
| Review threads with resolution state | `gh api graphql` (`reviewThreads`) |
| Reply to a thread | `gh api` (REST replies endpoint) or `gh api graphql` |
| Resolve a thread | `gh api graphql` (`resolveReviewThread`) |
| Library/API docs when judging a comment's validity | Context7 MCP **if configured**, otherwise `WebFetch` / `WebSearch` |
| Vulnerability/CVE checks on security comments | `WebSearch` / `WebFetch` against the advisory databases |

**No step in this skill may depend on an MCP server.** Context7 and Tavily are optional
accelerators; `WebSearch` and `WebFetch` cover the same ground. Never report a comment as
un-triageable because an MCP tool was missing.

Resolve the repo once, up front, and reuse it — never hardcode a repo name:

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)   # -> <owner>/<repo>
OWNER=${REPO%/*}; NAME=${REPO#*/}
```

## Workflow Overview

```
┌─────────────────────────────────────────────────────┐
│  1. GATHER — Fetch PR, diff, and all review threads │
├─────────────────────────────────────────────────────┤
│  2. TRIAGE — Classify each comment                  │
│     • valid                → fix                    │
│     • needs-clarification  → ask user               │
│     • already-resolved     → reply, then resolve    │
│     • disagree             → reply WITH the reason  │
├─────────────────────────────────────────────────────┤
│  3. CONTEXT — Load related issue/epic requirements  │
├─────────────────────────────────────────────────────┤
│  4. FIX — Apply changes, run tests, lint            │
├─────────────────────────────────────────────────────┤
│  5. COMMIT — Atomic commit referencing the PR       │
├─────────────────────────────────────────────────────┤
│  6. RESPOND — Reply to each thread, then resolve it │
├─────────────────────────────────────────────────────┤
│  7. REPORT — Summary to user                        │
└─────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Gather

1. **Fetch PR metadata**:
   ```bash
   gh pr view {PR_NUMBER} --json number,title,body,headRefName,baseRefName,state,url,closingIssuesReferences
   ```
   Extract any `Closes #N` references to find the parent issue/epic.

2. **Fetch every review thread with its resolution state.** This is the important call. The
   REST comments endpoint does *not* tell you whether a thread is resolved, so filtering on
   REST alone means re-fixing things that were settled days ago:

   ```bash
   gh api graphql -F owner="$OWNER" -F name="$NAME" -F pr={PR_NUMBER} -f query='
     query($owner: String!, $name: String!, $pr: Int!) {
       repository(owner: $owner, name: $name) {
         pullRequest(number: $pr) {
           reviewThreads(first: 100) {
             pageInfo { hasNextPage endCursor }
             nodes {
               id
               isResolved
               isOutdated
               isCollapsed
               path
               line
               originalLine
               comments(first: 50) {
                 nodes {
                   id
                   databaseId
                   author { login }
                   body
                   createdAt
                   diffHunk
                 }
               }
             }
           }
         }
       }
     }'
   ```

   Note what each id is for, because mixing them up is the usual failure:
   - `reviewThreads.nodes[].id` — the **thread node id**. This is what `resolveReviewThread`
     takes, and what the GraphQL reply mutation takes.
   - `comments.nodes[].id` — a comment **node id** (GraphQL).
   - `comments.nodes[].databaseId` — the numeric comment id the **REST** replies endpoint
     takes.

   Filter to `isResolved == false`. Page with `after: $cursor` while `hasNextPage` is true —
   a long review really does exceed 100 threads.

3. **Fetch review bodies too.** Top-level review summaries are not review threads and will
   be missed by the query above:
   ```bash
   gh api "repos/$REPO/pulls/{PR_NUMBER}/reviews" --paginate \
     --jq '.[] | select(.body != "") | {id, user: .user.login, state, body}'
   ```

4. **Fetch the diff** to understand the full change set:
   ```bash
   gh pr diff {PR_NUMBER}
   ```

5. **Read affected files** in the workspace for full context — the whole function and its
   callers, not just the diff hunk the comment is anchored to. Comments are frequently
   correct about a symptom and wrong about the location.

### Step 2: Triage

For each unresolved comment thread, classify it:

| Category | Criteria | Action |
|----------|----------|--------|
| **valid** | Clear code change requested, technically correct, consistent with project conventions | Fix it |
| **needs-clarification** | Ambiguous, or requires a product/design decision that is not yours to make | Reply asking the specific question; ask the user |
| **already-resolved** | The code the comment refers to has since changed, or another commit already addressed it | Reply naming the commit that did it, then resolve |
| **disagree** | The change would introduce a bug, contradict the linked issue's requirements, or violate a documented project rule | Reply **with the reason**; leave the thread open for the reviewer |
| **nit** | Style/cosmetic, valid but minor | Fix it — it is cheap, and unaddressed nits erode the review |

**A comment you decline must get a stated reason, in a reply, on that thread.** Silence is
not a triage outcome. "Not doing this" without a because reads as "not read", the reviewer
re-raises it on the next round, and the cost lands twice. Declining with a concrete reason —
the test it would break, the requirement it contradicts, the convention in `CLAUDE.md` it
violates — is a legitimate, complete resolution of a comment even though no code changed.
Do **not** resolve a `disagree` thread yourself; the reviewer decides whether your reason
lands.

**Validation checks for each comment:**
- Does the suggested change align with the linked issue/epic requirements and acceptance
  criteria?
- Does it follow the conventions in `CLAUDE.md` / `.claude/delivery.md`?
- Is the reviewer's claim about an API actually true? Check current docs (Context7 if
  configured, else `WebFetch` on the official documentation) rather than trusting either
  your memory or the reviewer's.
- Would the change break an existing test? Find the test before you decide, not after.
- For security comments, verify the specific claim (the CVE, the affected version range)
  rather than applying a change on the strength of the word "vulnerable".

### Step 3: Context Loading

Before applying fixes, ensure the broader picture is understood:

1. **Read the linked issue/epic** — requirements, acceptance criteria, definition of done:
   ```bash
   gh issue view {ISSUE_NUMBER} --json title,body,labels,comments
   ```
2. **Read the project docs** — scan `docs/` for relevant specs, the architecture document,
   and the user guide, plus `CLAUDE.md` for conventions.
3. **Establish a baseline** — run the project's test command *before* changing anything. If
   something is already red, you need to know that now; otherwise you will spend the session
   attributing a pre-existing failure to your own fix.

This prevents "fixing" a review comment in a way that violates the original requirements.

### Step 4: Fix

For each **valid** and **nit** comment:

1. Read the file and locate the code the comment refers to.
2. Apply the fix, respecting project conventions.
3. If the fix is non-trivial, write or update a test that covers it.
4. **Prove the test can fail.** Break the implementation deliberately, run the test, watch it
   go red, then restore the fix and watch it go green. A test that cannot fail is not a
   test — and a regression test added in response to a review comment is exactly the kind
   that silently asserts nothing, because it was written after the code it "covers" already
   worked.
5. Run the project's full test command — no regressions.
6. Run the linter.

**Rules:**
- Fix exactly what was requested — do not refactor adjacent code. A review round that
  arrives with unrelated changes forces a full re-review.
- **Lint only the files you changed** if the tree carries pre-existing findings. A whole-repo
  lint that reports hundreds of pre-existing problems can never go green and says nothing
  about your change. A new finding in a file you touched is yours; greening the repo is not
  this PR's job.
- **Do not reformat files you did not come to change.** A drive-by formatter run rewrites
  whole files, buries the real change, and will itself be raised as a review finding.
- If two comments conflict, resolve the conflict deliberately and say so in both replies.
- If a fix would break a test, investigate before touching the test. Changing the assertion
  to match the new behaviour is sometimes right and is more often how a real regression ships.

### Step 5: Commit

1. Stage explicit paths with `git add <paths>` — never `git add -A`, never a path the project
   protects, and never `git add -f` past an ignore rule. Check `git status` first.
2. Commit with a message that maps each change back to its comment:
   ```
   fix: address review comments from PR #{PR_NUMBER}

   - [{comment-id}] Description of fix
   - [{comment-id}] Description of fix
   ```
3. Push to the PR branch: `git push`

If the push is rejected, the branch moved. Fetch and rebase onto the remote head, re-run the
gate, and push again. Never force-push over commits you have not read — a reviewer may have
pushed a suggestion of their own.

### Step 6: Respond to Threads, Then Resolve Them

The order matters: **reply first, resolve second.** A thread that is resolved with no reply
gives the reviewer no way to check your work without diffing the branch themselves.

**Reply to a thread — REST** (uses the numeric `databaseId` of the *first* comment in the
thread):
```bash
gh api --method POST "repos/$REPO/pulls/{PR_NUMBER}/comments/{COMMENT_DATABASE_ID}/replies" \
  -f body="Fixed in $(git rev-parse --short HEAD) — {what changed and why}."
```

**Reply to a thread — GraphQL** (uses the thread node id; handy when you already have it
from Step 1):
```bash
gh api graphql -F threadId="{THREAD_NODE_ID}" -F body="{reply text}" -f query='
  mutation($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(
      input: { pullRequestReviewThreadId: $threadId, body: $body }
    ) {
      comment { id url }
    }
  }'
```

**Resolve the thread** — this is GraphQL only, and it takes the **thread** node id, not a
comment id:
```bash
gh api graphql -F threadId="{THREAD_NODE_ID}" -f query='
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }'
```

Check the response: `isResolved` must come back `true`. If it does not, the mutation did not
take (usually a permissions problem or a stale node id) — do not report the thread as closed.

`unresolveReviewThread` is the inverse, if you resolve one by mistake.

**Which threads to resolve:**

| Triage outcome | Reply | Resolve |
|----------------|-------|---------|
| valid / nit — fixed and pushed | yes, naming the commit | yes |
| already-resolved | yes, naming the commit that did it | yes |
| needs-clarification | yes, with the specific question | **no** — leave it open |
| disagree | yes, with the reason | **no** — the reviewer decides |

**Long reply bodies go in a file, never inline.** Anything past a sentence or two — a
multi-line explanation, a code block, a reasoned refusal — must be written to a file and
passed by path. Inlining multi-line markdown into a shell command corrupts it on backticks,
quotes and `$`, and the corruption is silent: the reply posts, mangled, and you will not see
it unless you go and look.
```bash
gh api --method POST "repos/$REPO/pulls/{PR_NUMBER}/comments/{COMMENT_DATABASE_ID}/replies" \
  -F body=@/path/to/reply.md
# and for a whole-PR summary comment:
gh pr comment {PR_NUMBER} --body-file /path/to/summary.md
```

**Fallback** — if thread ids cannot be resolved at all (an unusual permissions setup, a very
old PR), post one summary review comment rather than staying silent:
```bash
gh pr review {PR_NUMBER} --comment --body-file /path/to/summary.md
```
Say explicitly in your report that the individual threads were left unresolved, and why.

**Verify before reporting.** Re-run the Step 1 GraphQL query and confirm the threads you
claim to have closed now come back `isResolved: true`, and that nothing new arrived while
you were working.

### Step 7: Report

Present a summary to the user:

```
## PR #{PR_NUMBER} — Review Comments Resolved

### Fixed (N comments)
| # | File | Comment | Fix |
|---|------|---------|-----|
| 1 | src/foo.ts:42 | "Use const instead of let" | Changed to const |

### Needs Clarification (N comments) — threads left open
| # | File | Comment | Question |
|---|------|---------|----------|
| 1 | src/bar.ts:15 | "Should this validate input?" | The issue spec doesn't mention validation. Should I add it? |

### Declined (N comments) — threads left open, reason posted
| # | File | Comment | Reason given |
|---|------|---------|--------------|
| 1 | src/baz.ts:88 | "Cache this lookup" | The value is per-request and scoped to the caller; caching it would leak across requests |

### Already Resolved (N comments)
- Comment on line 20 of the old diff — code was rewritten in an earlier commit

**Commit:** `{sha}`
**Tests:** {result} ({N}% coverage, against the project's floor of {floor or "none set"})
**Lint:** {result — say which files were linted if the tree has pre-existing findings}
**Threads:** {N} resolved, {M} left open (verified via GraphQL)
**Conventions:** {read from CLAUDE.md / .claude/delivery.md, or inferred — say which}
```

## Error Recovery

| Scenario | Action |
|----------|--------|
| Cannot identify thread node ids | Re-run the GraphQL query with paging; if still unavailable, post one summary comment and say the threads are unresolved |
| `resolveReviewThread` returns `isResolved: false` or errors | Check `gh auth status` and write access; do not report the thread as closed |
| Fix breaks tests | Debug, adjust the fix, re-run. Do not edit the assertion to match the new behaviour without proving the new behaviour is correct |
| Comment references deleted code | Triage as already-resolved, reply saying where it went, resolve |
| Comment is factually wrong about an API | Verify against current docs, reply with the citation, leave open |
| Merge conflict on push | Fetch, rebase onto the base branch, re-run the gate, push. Never force-push over unread commits |
| Reviewer pushed commits while you worked | Rebase, re-run Step 1 — new threads may have appeared |
| CI red after push | Fix it before reporting done; `gh pr checks {PR_NUMBER}` and read the failing job's log |

## Example Invocations

```
resolve comments on PR #47
```

```
Fix the review feedback on my latest PR — the reviewer flagged some security issues
```

```
Address the changes requested on the open PR for this branch
```

## Shell Execution Rules

The full rules, shared with code-issue, are in
`${CLAUDE_PLUGIN_ROOT}/skills/code-issue/SHELL_RULES.md` — read it before your first gate run.

1. **Batch** dependent commands in one shell call joined with `&&`.
2. **No watch mode**, **no background processes** (`&`, `nohup`, `disown`) and **no interactive
   sessions** (REPLs, `git rebase -i`).
3. **Long text goes in a file, never on the command line**: `--body-file <path>`, or
   `-F body=@<path>` for `gh api`. Inline multi-line markdown is corrupted silently.
4. **The gate is whatever the project says it is.** Run the exact commands `CLAUDE.md` or
   `.claude/delivery.md` names, one batched call per toolchain your change touches; if neither
   names one, infer it from the manifest and CI workflow and say so.
5. **Lint only the files you changed** when the tree carries pre-existing findings.
6. **Keep output small** — quiet reporters, `tail -n 60` or a `grep` for failures.

## Prerequisites

- On the PR's feature branch (or able to check it out: `gh pr checkout {PR_NUMBER}`)
- `gh` CLI installed and authenticated (`gh auth status`) with write access to the repo
- Git configured with push access to the head branch
- The project's test runner and linter installed and runnable
