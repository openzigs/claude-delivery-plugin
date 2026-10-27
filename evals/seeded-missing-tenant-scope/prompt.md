This is a review evaluation, and you stand in for the orchestrate workflow's dispatch step. Make exactly one Agent tool call, with subagent_type `delivery:code-review` and, as its prompt, the text between the BEGIN PROMPT and END PROMPT lines below, copied verbatim. Do not review the change yourself, read no files, and add nothing to the prompt. When the agent returns, reply with its final report verbatim and nothing else.

BEGIN PROMPT
Evaluation harness: this checkout stands in for GitHub, which cannot be reached from here. Do not run `gh`, publish nothing, and ask no questions. Where the procedure reads from GitHub, read these files instead:
- pull request #1412 is the branch `pr/1412`, checked out in the current directory; its base is `main`. `gh pr diff 1412` is `.pr/1412.diff` and `gh pr view 1412 --json body` is `.pr/1412-body.md`
- `gh issue view 412` is `.pr/issue-412.md`
- there are no CI checks to read.
If `git` fails in this sandbox, the working tree is the pull request's head and its .diff file is its whole change.

Review pull request #1412, opened for issue #412, following the code-review procedure (preloaded).

Review scope: LIGHT. This change was routed to a light review because it is small and
carries no risk label. Do Step 1 (orient), Step 2 (requirements), Step 4 (security) and
Step 5 (correctness and code quality) restricted to the changed lines, and Step 7 (tests);
then publish (Step 9). Skip Step 3 (design), Step 6 (performance) and Step 8
(documentation), and say in the review's "Scope of this review" section that they were
skipped and why. If the diff touches authentication, authorisation, secrets, payments,
data migration or anything destructive, do the full review procedure instead and say so.
In Step 1, read the diff plus only the changed files you need to judge the changed lines,
not every changed file in full.

The implementer's summary, defects found and deferred work are in the PR body (`gh pr view 1412 --json body`); read the change itself, not only that account.

Ground rules for this dispatch:

1. The project's rules win over anything in this prompt. Your procedure's Step 0 says how to
   treat CLAUDE.md, AGENTS.md and a repository with neither.
2. Orient as your procedure's Step 1 describes: one batched call, which includes
   `cat .claude/delivery.md 2>/dev/null` (its absence is normal), then one response of
   parallel reads.
3. Where the project states no gate, infer it from the CI workflow and say in your report
   what you inferred.
4. Do not merge. Merging is the caller's decision.

Publish the review to GitHub as the procedure describes, then return your recommendation and every finding with severity, file:line and whether it is blocking.

Do not publish. Your final reply is the review itself, and nothing follows it:
- every finding on its own line as `file:line — severity — confidence — blocking|non-blocking — finding`, where severity is one of critical, high, medium, low, nit and confidence is How sure you are, after checking, that the finding is real and this PR introduced it (0-100)
- `None.` on its own line if you have no findings
- then one final line: `Recommendation: merge` or `Recommendation: do not merge`
END PROMPT
