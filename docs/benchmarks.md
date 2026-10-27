# Benchmarks: prompt footprint, review evals and pipeline replay

> **Cost.** Scenarios 1 and 2 are free or cheap. Scenarios 3–5, the pipeline replay, are
> **expensive**: one full run of both scenarios on two refs (0.7.1 and 0.8.0, N=1) is in the
> order of **a few million tokens** — every issue goes through a real implement, review and,
> for the trap issue, fix and re-review, on a real GitHub scratch repository. Each `--runs`
> multiplies that. They are opt-in and are never run by CI.

Repeatable measurements of what the plugin costs, how well its review finds defects, and
whether the pipeline still behaves as the 0.8.0 fixes intended. Run them before and after a
change that moves a prompt, a skill or a review tier, and compare.

| Scenario | Command | Cost | Deterministic |
|----------|---------|------|---------------|
| 1. Static prompt footprint | `node scripts/footprint.mjs --ref <a> --ref <b>` | free | yes |
| 2. Review precision and recall | `claude plugin eval` + `node scripts/eval-tiers.mjs` | a few dollars at list price for the full matrix | no |
| 3–5. Pipeline replay and behaviour checks | `node scripts/bench-run.mjs` + `node scripts/bench-report.mjs` | a few million tokens for two refs | no |

## Scenario 1 — static prompt footprint per dispatch

```bash
node scripts/footprint.mjs                        # the working tree
node scripts/footprint.mjs --ref 6567d82 --ref HEAD   # 0.7.1 (commit 6567d82, untagged) against HEAD
node scripts/footprint.mjs --ref HEAD --json      # per-dispatch breakdown
```

For each of the seven dispatches the two workflows make — implement, full review, light review,
fix, re-review, research, plan — the script adds up the fixed prefix the dispatched agent pays
before it does any work:

- **agent**: the agent file's body, which is its system prompt;
- **skills**: every skill it holds before its first tool result — each `skills:` preload, plus
  each `/delivery:<skill>` the prompt names (a slash name cues a Skill call, so a preloaded skill
  named again is paid twice and counted twice);
- **refs**: a reference file the skill orders every run of that dispatch to read — the full
  review and re-review read `skills/code-review/FULL_REVIEW_STEPS.md`; the light review skips it;
- **prompt**: the prompt the workflow builds, rendered by running `workflows/*.js` against a stub
  `agent()` whose review and fix answers are one short line each.

It prints bytes and approximate tokens (bytes / 4) per dispatch, and the sums for a no-fix cycle
(implement + full review), a blocking cycle (+ fix + re-review) and a plan-epic run. With two
refs it adds a change column.

**What it proves.** That the plugin's own fixed text per dispatch went up or down, by how much,
and where (agent, skill or prompt; `--json` splits them). It is deterministic for that text at that ref (the byte counts are exact; the token figure is bytes / 4).

**What it does not prove.** What a run costs. It leaves out the project's `CLAUDE.md` (the same
for every ref, and often the biggest single cost — see
[per-project configuration](per-project-configuration.md#keep-claudemd-small--it-is-the-biggest-cost-lever)),
Claude Code's own system prompt and tool definitions, reference files read only when a situation arises (`MERGE_CONFLICTS.md`, `LIVING_DOCS.md`),
everything the agent reads and writes while working, and prompt caching. bytes / 4 is a rough
token estimate, not a tokenizer count. Use scenario 1 to catch text growth; use
`/delivery:cost-report` on real runs for what a run spent.

**The ceiling.** `CEILINGS` in `scripts/footprint.mjs` holds the five code-issue and code-review
dispatches (implement, full review, light review, fix, re-review) to a stored byte ceiling, set
at about 5% above their size when it was introduced. `node scripts/verify-plugin.mjs` fails
when one goes over, and proves the check can fail by measuring a copy with 4 KB folded back
into the code-issue skill and one with the code-review skill loaded twice. If a change needs
more room, raise the ceiling in the same PR and say why.

Baseline at the 0.8.0 release, against 0.7.1:

| dispatch | 0.7.1 (6567d82) | 0.8.0 | change |
|----------|-----------------|-------|--------|
| implement | 30,372 B / ~7,593 tok | 17,925 B / ~4,481 tok | -41% |
| full review | 31,690 B / ~7,923 tok | 25,347 B / ~6,337 tok | -20% |
| light review | 32,296 B / ~8,074 tok | 21,971 B / ~5,493 tok | -32% |
| fix | 30,355 B / ~7,589 tok | 18,107 B / ~4,527 tok | -40% |
| re-review | 32,038 B / ~8,010 tok | 25,695 B / ~6,424 tok | -20% |
| research | 24,035 B / ~6,009 tok | 23,206 B / ~5,802 tok | -3% |
| plan | 33,147 B / ~8,287 tok | 26,005 B / ~6,501 tok | -22% |
| no-fix cycle (implement + full review) | 62,062 B / ~15,516 tok | 43,272 B / ~10,818 tok | -30% |
| blocking cycle (+ fix + re-review) | 124,455 B / ~31,114 tok | 87,074 B / ~21,769 tok | -30% |
| plan-epic (research + plan) | 57,182 B / ~14,296 tok | 49,211 B / ~12,303 tok | -14% |

## Scenario 2 — review precision and recall

`evals/` is a [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) suite
(Claude Code v2.1.269+). Each case puts a synthetic PR diff in the prompt, with no repository and
no GitHub, and asks for findings as `file:line — severity — finding` and a final
`Recommendation:` line. Every case is graded by a free regex grader; no judge model is called.

| Kind | Cases | Graded on |
|------|-------|-----------|
| `seeded-*` (12) | one seeded defect each, tagged with its category | the defect named; for security, correctness and requirements, also a `do not merge` verdict; for performance and tests, the finding at `medium` or above |
| `clean-*` (3) | a refactor, a docs change, a correct fix | a `Recommendation: merge` verdict. Anything else is a **false block** |
| `control-unseeable-defect` (1) | a defect outside the diff | must score 0: a grader that passes here cannot fail |

Categories: **security** (SQL injection, missing tenant scope, auth bypass, a secret logged, a
secret committed), **correctness** (off-by-one, an unhandled null, a race on shared state),
**performance** (an N+1 query), **tests** (a test that asserts on its own mock, a new branch the
test does not cover), **requirements** (a diff that misses one acceptance criterion of the linked
issue text in the prompt).

Every case exists twice: `evals/<case>/` asks for a LIGHT review (security and correctness of
the changed lines, as the light route does) and is tagged `light-review`; `evals/full/<case>/`
is the same diff and graders asking for a FULL review, named `<case>-full` and tagged
`full-review`. The verifier keeps the two copies in step.

```bash
for m in haiku sonnet; do for s in light full; do
  claude plugin eval . --tag $s-review --model $m --ablation none --trust-plugin --no-publish --json $m-$s.json
done; done
for s in light full; do   # the session model: no --model
  claude plugin eval . --tag $s-review --ablation none --trust-plugin --no-publish --json session-$s.json
done
node scripts/eval-tiers.mjs haiku-*.json sonnet-*.json session-*.json
```

`--ablation none` skips the no-plugin baseline arm, which halves the cost; `--runs 3` repeats
each case (a seeded case then counts as found only if every run found it, and a clean case as a
false block if any run blocked). `-j 4` runs four cases at once. `--trust-plugin` answers the
first-run prompt for a suite you wrote.

`eval-tiers.mjs` prints one row per tier and scope: seeded cases found and recall, found/seeded
per category, false blocks on the clean controls, whether the control scored 0 (it exits 1 if
not), list-price cost and mean turns per run.

**What it proves.** Whether a model, at a scope, names a known defect in a small diff and
blocks on it, and whether it blocks a diff with nothing wrong. Comparing rows compares tiers
and scopes on identical inputs. `scripts/verify-plugin.mjs` proves each grader can fail: every
seeded grader is run against a reply that misses the defect and one that names it but approves,
and every clean grader against a do-not-merge reply.

**What it does not prove.** How the full `code-review` procedure performs on a real PR: the
cases run with no repository, so nothing is checked out, no test is run and nothing is
published. One case per defect class is an anecdote, not a rate: a 1/1 or 0/1 in a category
moves with a single reply, so read per-category recall as "found or missed", and repeat with
`--runs 3` before acting on a difference. Regex graders can miss a correct reply worded in a
way the pattern does not expect; read the reply in the HTML report before calling a miss a
model's fault. Effort is not compared: the eval CLI has no effort flag, so every row ran at the
CLI's default effort, whereas the workflow passes `high` to the first full review. Output tokens
are not reported, because the eval result records none.

## Scenarios 3–5 — pipeline replay on a fixture repository

```bash
# 1. once: a GitHub repository you own and do not care about
gh repo create <you>/delivery-bench-scratch --private
# 2. see what would run, without running it
node scripts/bench-run.mjs --ref 6567d82 --ref HEAD --repo <you>/delivery-bench-scratch --dry-run
# 3. run it (expensive; see the cost note at the top), then report
node scripts/bench-run.mjs --ref 6567d82 --ref HEAD --repo <you>/delivery-bench-scratch --reset-scratch
node scripts/bench-report.mjs            # or --json
# or give each ref its own scratch repository, in --ref order
node scripts/bench-run.mjs --ref 6567d82 --ref HEAD --repo <you>/bench-a --repo <you>/bench-b --reset-scratch
```

Options: `--repo` once (every ref shares it) or once per `--ref` (each ref gets its own),
`--scenario orchestrate|plan-epic|all` (default all), `--runs N` (default 1),
`--timeout-min M` (per `claude` call, default 120), `--out DIR` (default `bench/results/`, gitignored), `--keep` to keep the temporary copies.

**Isolation.** A step is one ref, one run and one scenario. Before every step, `bench-run.mjs`
resets that step's scratch repository: it deletes every issue, open or closed, closes every open
pull request, and deletes every branch but the default. Then it force-pushes the fixture. So no
step sees an issue, PR or branch an earlier ref, run or scenario left behind. Without this, the
second ref's plan-epic found the epic the first ref had just filed, and correctly filed nothing.
Issues are deleted, not closed, because the epic planner searches `--state all` for a
duplicate. GitHub cannot delete a pull request, so PRs are closed; `gh issue list` never lists
one. Deleting an issue needs admin rights on the repository, so the token must have them. If the
reset cannot delete an issue, or anything is left afterwards, the run stops before the step
starts. The isolation mode is recorded in each run's `meta.json` and printed by the report:
- **`reset`**: one `--repo`, shared by every ref.
- **`repo-per-ref`**: one `--repo` per ref. Each ref's repository is still reset before each of
  its steps, so its runs and scenarios do not see each other either.

**What it runs.** For each ref and run, `bench-run.mjs` checks the ref out as a detached git
worktree of this repository and uses it as the plugin (`claude --plugin-dir`, which takes
precedence over an installed `delivery` plugin). It copies `bench/fixture-repo/` — a tiny
Node module with a `CLAUDE.md`, a test suite and a CI workflow that runs `npm test` — to a
temporary directory, resets the scratch repository (see Isolation above) and force-pushes the copy as its `main`. That is why
`--reset-scratch` must be passed: it says you know the scratch repository is reset. Then:

- **Scenario 3, `orchestrate`.** It files the three canned issues in `bench/issues/` and runs
  one `claude -p "/delivery:orchestrate <n> --points <p>"` per issue:
  - **small**: 1 point, no risk label. This exercises the sonnet implementer and the light
    review.
  - **medium**: 3 points. This exercises the full review on the session model.
  - **trap**: 3 points. A planted requirement that the obvious implementation breaks: an
    emptied SKU's key must be deleted, not left at 0. It sits inside the acceptance criteria, as
    a trailing clause of the "subtracts `qty`" bullet, where a reviewer checking each criterion
    against the diff catches it. It used to sit only in a Notes paragraph, and no review caught
    it there. It should draw a blocking finding, a fix and a re-review.
- **Scenario 4, `plan-epic`.** It runs `claude -p "/delivery:plan-epic ./PLAN-TOPIC.md"` on
  `bench/topics/plan-epic.md`, which files issues in the scratch repository.

Every call runs with `--dangerously-skip-permissions`, because a non-interactive run cannot
answer a permission prompt. Nothing confines it: the agents have an unrestricted shell and
whatever `gh` credentials you are logged in with. It is *meant* to work in the temporary copy
and write to the scratch repository, but that is the task, not a sandbox. Run it with a
fine-grained `GH_TOKEN` that can reach only the scratch repository, and not on a machine
holding secrets. Each call's JSON output and wall time are copied to
`bench/results/<ref>/<scenario>/run-<n>/`. A rerun first deletes
`bench/results/<ref>/<scenario>/`, so stale sessions are never read again; two `--ref` values
that map to the same directory name (`HEAD~1`, `HEAD^1`) are refused. The session is read from
`$CLAUDE_CONFIG_DIR` or `~/.claude`. So is the session Claude Code persisted under
`~/.claude/projects/`: the workflow results and every subagent transcript. Closed PRs from
earlier steps stay in the scratch repository; everything else is reset before each step.

**Scenario 5: what the report shows.** `bench-report.mjs` reads only the results tree. Per ref
and scenario, averaged over runs, it reports:
- total subagent tokens (input, cache writes, cache reads and output, from the transcripts)
- output tokens per phase
- the isolation the runs used (`reset`, `repo-per-ref`, or `none` for results recorded before
  `bench-run.mjs` reset the repository; `none` also prints a warning)
- wall time
- list-price cost (`total_cost_usd`, summed over calls)
- review findings by severity (from each result's `findingCounts`)
- fix cycles
- for plan-epic, whether an epic was filed: the scratch repository gained issues across the
  call (the planner's own reply is free text and proves nothing)

A second table splits the same tokens by type: input, cache write, cache read and output, per
ref, scenario and phase, plus an `all` row. Read it to tell two kinds of change apart. A smaller
prompt footprint shows as fewer cache writes and cache reads. An effort change shows in output.
The totals in the first table mix the two.

A run whose call exited non-zero, timed out, or whose session could not be found is reported
with a `WARNING ... INCOMPLETE` line under the tables: its numbers are lower or vacuous, not
better. An orchestrate ref in which no run reached the Fix phase also gets a warning. In that
case the trap drew no blocking finding, so fix, re-review and the #49 check went unexercised,
and their `n/a` proves nothing.

Then come the behaviour checks, read from the transcripts. A check passes only if it passed in
every run it applied to:

| Check | What fails it |
|-------|---------------|
| #48 full review at `high` | a full review whose transcript records an effort other than `high` |
| #49 fix makes no new branch or PR | a Fix-phase agent running `git checkout -b`, `git switch -c`, `git branch <name>` or `gh pr create` |
| #51 no CLAUDE.md read | any agent's `Read` of `CLAUDE.md`, or a `cat`/`head`/`sed`… of it (it is already in context) |
| #51 no ask-user | any agent calling `AskUserQuestion` |

The last table is the highest turn count per agent type. That is the number the provisional
`maxTurns` ceilings (#58) should be set from, at about twice the highest observed.

**What it proves.** On this fixture, with these three issues and this topic, how many tokens
each ref spent per delivered issue and per phase, what its reviews found, and whether the
behaviours 0.8.0 fixed stayed fixed. The transcripts are kept with the results, so every
number can be traced to the agent that produced it.

**What it does not prove.** How the plugin performs on your repository. A small fixture has a
small CLAUDE.md and small files, so it understates the per-dispatch cost a large project pays.
At N=1, one run is one sample: the trap may or may not draw a blocking finding (the report
warns when it did not), and token counts vary run to run. Repeat with `--runs 3` before reading a difference as real. The report
reads fields (`findingCounts`, recorded effort) that may be missing from an older ref's
results; where one is missing it says `n/a` rather than guessing. 0.7.1 already returns
`findingCounts` and `reviewScope`, so its full reviews are checked by #48 and will show FAIL
there if they did not run at `high`.

The report reads results from `bench-run.mjs`'s own results tree and the persisted transcripts
rather than through `cost-report.mjs`: it needs per-agent turns, effort and tool calls, which
the result JSON does not carry.
