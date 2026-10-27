This is a review evaluation, and you stand in for the orchestrate workflow's dispatch step. Make exactly one Agent tool call, with subagent_type `delivery:code-review` and, as its prompt, the text between the BEGIN PROMPT and END PROMPT lines below, copied verbatim. Do not review the change yourself, read no files, and add nothing to the prompt. When the agent returns, reply with its final report verbatim and nothing else.

BEGIN PROMPT
Evaluation harness: this checkout stands in for GitHub, which cannot be reached from here. Do not run `gh`, publish nothing, and ask no questions. Where the procedure reads from GitHub, read these files instead:
- pull request #1412 is the branch `pr/1412`; its base is `main`. `gh pr diff 1412` is `.pr/1412.diff` and `gh pr view 1412 --json body` is `.pr/1412-body.md`
- `gh issue view 412` is `.pr/issue-412.md`
- pull request #1413 is the branch `pr/1413`; its base is `main`. `gh pr diff 1413` is `.pr/1413.diff` and `gh pr view 1413 --json body` is `.pr/1413-body.md`
- `gh issue view 413` is `.pr/issue-413.md`
- pull request #1415 is the branch `pr/1415`; its base is `main`. `gh pr diff 1415` is `.pr/1415.diff` and `gh pr view 1415 --json body` is `.pr/1415-body.md`
- `gh issue view 415` is `.pr/issue-415.md`
- there are no CI checks to read.
The checkout is `main`, the base of every pull request. If `git` fails in this sandbox, each .diff file is that pull request's whole change.

Review these pull requests from one batch in a single pass, following the code-review procedure (preloaded) at full scope for each: PR #1412 (issue #412), PR #1413 (issue #413), PR #1415 (issue #415).

Judge each PR on its own diff and its own issue: a finding belongs to the PR that introduced it. Each implementer's summary is in its PR body (`gh pr view <pr> --json body`); read the change itself, not only that account.

Ground rules for this dispatch:

1. The project's rules win over anything in this prompt. Your procedure's Step 0 says how to
   treat CLAUDE.md, AGENTS.md and a repository with neither.
2. Orient as your procedure's Step 1 describes: one batched call, which includes
   `cat .claude/delivery.md 2>/dev/null` (its absence is normal), then one response of
   parallel reads.
3. Where the project states no gate, infer it from the CI workflow and say in your report
   what you inferred.
4. Do not merge. Merging is the caller's decision.

Publish a separate review on EACH pull request, with that PR's findings and its own Recommendation: line, as the procedure describes. Then return one entry per PR, with its pr number, recommendation and every finding with severity, file:line and whether it is blocking.

Do not publish. Your final reply is the reviews themselves, one section per pull request, in this order: #1412, #1413, #1415. Each section opens with a heading line `## PR #<number>`, then:
- every finding for that pull request on its own line as `file:line — severity — confidence — blocking|non-blocking — finding`, where severity is one of critical, high, medium, low, nit and confidence is How sure you are, after checking, that the finding is real and this PR introduced it (0-100)
- `None.` on its own line if it has no findings
- then that pull request's own line: `Recommendation: merge` or `Recommendation: do not merge`
END PROMPT
