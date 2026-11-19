# Benchmarks: prompt footprint, review evals and pipeline replay

> **Cost.** Scenario 1 is free. Scenario 2's full matrix (three tiers, two scopes, N=3) cost
> about **$83 at list price** at #92, most of it the session model; one tier on one scope is
> cents to dollars. Scenarios 3–5, the pipeline replay, are
> **expensive**: one full run of both scenarios on two refs (0.7.1 and 0.8.0, N=1) is in the
> order of **a few million tokens** — every issue goes through a real implement, review and,
> for the caller issue, fix and re-review, on a real GitHub scratch repository. Each `--runs`
> multiplies that. They are opt-in and are never run by CI.

Repeatable measurements of what the plugin costs, how well its review finds defects, and
whether the pipeline still behaves as the 0.8.0 fixes intended. Run them before and after a
change that moves a prompt, a skill or a review tier, and compare.

| Scenario | Command | Cost | Deterministic |
|----------|---------|------|---------------|
| 1. Static prompt footprint | `node scripts/footprint.mjs --ref <a> --ref <b>` | free | yes |
| 2. Review precision and recall | `node scripts/eval-run.mjs` (`claude plugin eval` + `scripts/eval-tiers.mjs`) | about $83 at list price for the full matrix at N=3 (haiku $2, sonnet $23, session model $58) | no |
| 3–5. Pipeline replay and behaviour checks | `node scripts/bench-run.mjs` + `node scripts/bench-report.mjs` | a few million tokens for two refs | no |

## What real runs measure that these scenarios cannot

The three scenarios below run on a small fixture with a six-second CI. Two free, read-only
scripts read your own project's saved runs instead:

```bash
node scripts/findings-report.mjs --discover --last 50   # also /delivery:retro
node scripts/doctor.mjs                                 # also /delivery:doctor
```

`findings-report.mjs` reports fix and still-blocking rates, blocking findings by class and area,
and which routes fired, from the same result files `cost-report.mjs` reads. `doctor.mjs` reports
what will make a run slow, expensive or unverifiable in the current repository.

The 0.10.0 changes rest on such data rather than on the replay: 630 orchestrate runs (1,589 PRs)
and about 9,000 subagent transcripts from four real repositories. Weighting tokens as cache
read 0.1, 5-minute cache write 1.25 and output 5, a single-issue implementer on the session
model (n=103) took a median 113 turns, its context grew to a median 385k tokens, and its cost
split 64% cache reads, 35% cache writes and 1% output. It hit 3.7 gaps of more than five minutes
per run, and about two thirds of all such gaps followed a CI wait. That is why one CI wait is
capped at 270 s, and why per-phase output tokens (`budget.spent()` deltas) understate where a
run's cost goes. The replay cannot reproduce either effect: its issues are small and its CI
finishes inside the cache window.

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
(Claude Code v2.1.269+). Each case runs the review **the way `/delivery:orchestrate` does**:
the session dispatches the `delivery:code-review` agent, whose `skills:` frontmatter preloads
the review procedure, with the review prompt the workflow itself builds. The reviewer works on
a checked-out fixture repository, not a diff pasted into its prompt, so a defect that is only
visible in an unchanged file can be found by reading that file, and missed by not reading it.

| Kind | Cases | Graded on |
|------|-------|-----------|
| `seeded-*` (21) | one seeded defect each, tagged with its category | the defect named; for security, correctness and requirements, also a `do not merge` verdict; for performance and tests, the finding at `medium` or above |
| `clean-*` (5) | a refactor, a docs change, a correct fix, and two **decoys**: code that looks dangerous but is correct | a `Recommendation: merge` verdict. Anything else is a **false block** |
| `control-unseeable-defect` (1) | a defect whose cause is in no file of the repository | must score 0: a grader that passes here cannot fail |
| `batch-three-prs`, `per-pr-three-prs` | three PRs (two seeded, one clean) reviewed as one `--batch-review` dispatch, or as three per-PR dispatches | each PR's own section of the reply, so a finding under the wrong PR does not count |

The twelve original seeded cases cover **security** (SQL injection, missing tenant scope, auth
bypass, a secret logged, a secret committed), **correctness** (off-by-one, an unhandled null, a
race on shared state), **performance** (an N+1 query), **tests** (a test that asserts on its own
mock, a new branch the test does not cover) and **requirements** (a missed acceptance
criterion). The nine harder ones (#92) cannot be judged from the changed lines alone:

| Case | Category | What it takes to find it |
|------|----------|--------------------------|
| `seeded-invariant-violation` | correctness | a new caller posts fractional cents; the integer-cents rule is stated only in the unchanged `src/ledger.js` |
| `seeded-authz-moved` | security | a "pure move" of a route between files drops the admin check, which lives in the unchanged `src/app.js` mount |
| `seeded-race-lock-helper` | correctness | the new code serialises with `withLock`, and only the unchanged helper shows it releases the lock before an async callback finishes |
| `seeded-migration-breaks-query` | correctness | a column rename is correct on its own, but the unchanged revenue report still selects the old name |
| `seeded-fixture-hides-bug` | tests | the tests pass only because the unchanged JSON fixture has no mixed-case emails |
| `seeded-issue-only-requirement` | requirements | the "same response whether or not the account exists" rule is only in the linked issue |
| `seeded-quadratic-helper` | performance | a lookup becomes O(n×m) through an unchanged linear `findById` helper |
| `seeded-wrong-library-api` | correctness | `maxAge` is in milliseconds, which only the installed source under `node_modules/` says |
| `seeded-large-diff` | security | one missing four-eyes check buried in a 455-line change |

The two decoys are `clean-decoy-allowlisted-sort` (an `ORDER BY ${column}` whose column comes
from a fixed `Map`) and `clean-decoy-publishable-key` (a Stripe *publishable* key, public by
design, built into the browser bundle).

Every case exists twice: `evals/<case>/` at LIGHT scope (tagged `light-review`) and
`evals/full/<case>/` at FULL scope (`<case>-full`, tagged `full-review`). Each case is written
by hand as a `case.yaml` (its tags), a `fixture.txt` (the repository, the PR and its linked
issue) and its graders. **Everything else is generated** by `node scripts/eval-build.mjs`:

- **The prompt is rendered from `workflows/orchestrate.js`**, by running it against a stub
  `agent()` as `scripts/footprint.mjs` does: the light route's prompt, carrying the workflow's
  own `LIGHT_SCOPE` text, for the light copy; the full route's for the full copy; the
  `--batch-review` prompt and the per-PR prompts for the batch comparison. Only two things are
  added around it: where the `gh` reads are instead (the fixture writes the PR diff, body and
  linked issue under `.pr/`, because the eval sandbox reaches no GitHub), and the reply format
  the graders read (one line per finding with its severity, confidence and whether it blocks,
  then the `Recommendation:` line). `node scripts/verify-plugin.mjs` fails when a generated file
  is stale, so editing the workflow's prompt text without re-running the build fails CI.
- **`scaffold.sh`** builds the fixture repository with `scripts/eval-scaffold.mjs`: `main`
  holds the base, `pr/<n>` the change, and `.pr/` the stand-ins for `gh`. It refuses to run
  in a directory that is not empty.
- **`graders/review-agent-dispatched.md`** checks that the session dispatched
  `delivery:code-review`. A run where it did not reviewed nothing with the plugin's procedure;
  `eval-tiers.mjs` reports it as **INVALID**, leaves it out of every rate, and exits 1.

```bash
node scripts/eval-run.mjs --dry-run       # the nine claude plugin eval calls it would make
node scripts/eval-run.mjs                 # haiku, sonnet, session model x light, full, batch; N=3
node scripts/eval-run.mjs --tier haiku --scope light --runs 1      # one cell, once
node scripts/eval-tiers.mjs evals/results/matrix-*/*/*.json      # report saved results again
```

`eval-run.mjs` makes one `claude plugin eval` call per tier and scope, with `--scaffold` (the
cases build their repository), `--allow-tools Bash` (the reviewer reads and runs things in it,
under the eval sandbox), `--ablation none` (without the plugin there is no reviewer agent to
compare against) and `--keep-temp`. It copies each run's trace next to its result, so the
report can count the reviewer's turns and read its findings, and deletes the kept run
directory. `--tier`, `--scope`, `--case GLOB`, `--runs N` (default 3), `-j N` and
`--max-cost-usd` narrow it. `eval-tiers.mjs` merges every file of one tier, and a case found in
more than one file is taken from the last one named, so after fixing a fixture or a grader you
re-run only that case (`--case 'seeded-x*' --out <dir>`) and list its results after the rest.
The session tier passes no `--model`; every agent the session dispatches inherits its model, so
the reviewer runs on the tier under test.

**What the report shows.** Per tier and scope, over N passes of the suite:

- **recall** as the mean with the lowest and highest pass, overall and per category;
- **false blocks** on the clean cases, decoys included, as mean and range;
- **cost** of one pass (list price) and **turns** per run (the dispatching session's plus the
  reviewer's own, read from the trace), as mean and range;
- for two tiers in one scope whose recall ranges overlap: *not distinguishable at N=3*;
- **batch review** (#66): recall over the two seeded PRs and false blocks on the clean one, per
  mode, and the graduation criterion with its verdict;
- **confidence calibration** (#65): every finding line classed as the seeded defect (it matches
  the case's grader), a decoy (it matches the decoy's bait pattern), on a clean change, or other;
  and how many in each class fall under a confidence of 30, 50 and 70, split by what
  `CONFIDENCE_THRESHOLD` would actually drop (non-blocking findings only).

**Graduating `--batch-review`.** It drops "experimental" when, on the session model (the model
a batch review runs on) at N≥3 valid runs per mode, the batch review's mean recall is at least
the per-PR review's lowest run, and it false-blocks the clean PR no more often than per-PR
review does. `eval-tiers.mjs` prints the verdict per tier.

**Grader proof.** `scripts/verify-plugin.mjs` proves each grader can fail without a model call:
every seeded grader is run against a reply that misses the defect, one that names it but
approves, five that block on a different defect, and every other seeded case's hit (the two
race cases share a defect class and are allowed to match each other); every clean grader
against a do-not-merge reply; each decoy's bait pattern against a finding that takes the bait;
each batch grader against a reply with the two defects swapped between PR sections.

### Results at #92 (Claude Code 2.1.311, N=3)

Tiers: haiku is `claude-haiku-5-5`, sonnet `claude-sonnet-5-5`, the session model
`claude-opus-5-5`; the reviewer inherits the session's model. 504 runs, none invalid: every run
dispatched `delivery:code-review`. Recall is the mean over three passes of the suite, with the
lowest and highest pass.

| tier | scope | recall (21 seeded) | tests category (3) | false blocks (5 clean) | cost per pass | turns per run |
|------|-------|--------------------|--------------------|------------------------|---------------|---------------|
| haiku | light | 97% [95–100%] | 78% [67–100%] | 13% [0–20%] | $0.34 | 5.7 [4–10] |
| haiku | full | 100% [100–100%] | 100% | 0% | $0.35 | 6.2 [4–11] |
| sonnet | light | 98% [95–100%] | 89% [67–100%] | 0% | $3.76 | 4.0 [3–5] |
| sonnet | full | 100% [100–100%] | 100% | 0% | $3.56 | 4.2 [3–6] |
| session model | light | 100% [100–100%] | 100% | 0% | $9.39 | 4.8 [4–7] |
| session model | full | 100% [100–100%] | 100% | 0% | $8.45 | 4.9 [4–8] |

Every pair of tiers overlaps on recall in both scopes: **not distinguishable at N=3**. Security,
correctness, performance and requirements were found in every run by every tier. The misses were
`seeded-fixture-hides-bug` (haiku and sonnet at light scope rated the case-sensitive comparison
`low`), and haiku's light-scope false blocks were a docs change it blocked over a pre-existing
gap in the integration setup and the publishable-key decoy, which it blocked as a live key in
non-production builds. Turns are few because the procedure orients with one batched read.

Batch review, two seeded PRs and one clean one, three runs per mode:

| tier | batch recall | per-PR recall | false blocks (both modes) | batch cost / per-PR cost | criterion |
|------|--------------|---------------|---------------------------|--------------------------|-----------|
| haiku | 100% | 100% | 0 | $0.019 / $0.033 | met |
| sonnet | 67% [50–100%] | 100% | 0 | $0.149 / $0.293 | **not met** |
| session model | 100% | 100% | 0 | $0.497 / $0.837 | met |

Sonnet's batch review twice assumed `pg` returns `Date` objects without reading `src/db.js`,
and approved PR #1413; reviewed on its own, it read the file every time.

Confidence calibration over 2,481 findings (`dropped` counts the non-blocking ones under the
threshold, which is all `CONFIDENCE_THRESHOLD` removes):

| finding is | count | blocking | dropped <30 | dropped <50 | dropped <70 |
|------------|-------|----------|-------------|-------------|-------------|
| the seeded defect | 836 | 599 | 0 | 11 | 68 |
| a decoy's bait | 1 | 1 | 0 | 0 | 0 |
| on a clean change | 234 | 1 | 2 | 36 | 134 |
| other (truth unknown) | 1,410 | 285 | 10 | 191 | 621 |

No threshold tested would have lost a seeded defect: in each of the 400 replies that named one,
some finding naming it was blocking or rated 70 or more.

**What it proves.** Whether a model, at a scope, running the plugin's real review procedure,
names a known defect in a small repository and blocks on it, and whether it blocks a change
with nothing wrong, with the run-to-run spread at N passes. Comparing rows compares tiers and
scopes on identical inputs.

**What it does not prove.** How the procedure performs on your repository: the fixtures are
small, there is no CI to read and nothing is published. Under the macOS sandbox `git` cannot
run (the Xcode shim it needs is blocked), so the reviewer reads the `.pr/` diff and the working
tree instead of running `git diff`; on Linux it runs. One case per defect class is an anecdote:
read per-category recall as "found or missed", and trust a difference only when the ranges do
not overlap. Regex graders can miss a correct reply worded in a way the pattern does not
expect; read the trace (`traces/` beside each result) before calling a miss a model's fault.
Effort is not compared: the eval CLI has no effort flag, so every row ran at the CLI's default
effort, whereas the workflow passes `high` to the first full review.

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
`--timeout-min M` (per `claude` call, default 120), `--out DIR` (default `bench/results/`, gitignored), `--keep` to keep the temporary copies,
`--orchestrate-args "<flags>"` to append orchestrate flags to every orchestrate call.

**Two settings on one ref.** `--orchestrate-args` (for example `"--small-effort medium"`) is
appended to each `/delivery:orchestrate` call of the invocation, never to plan-epic. It must be
flags: the first word a `--flag`, each word letters, digits, `=`, `.`, `_` or `-`. Its results
go to `bench/results/<ref>+<flags>/`, so a plain run of the same ref is neither cleared nor
mixed in; `meta.json` records the flags, and the report labels the ref `<ref> [<flags>]` and
prints the implement effort each orchestrate result recorded. Run the ref once without and
once with the flags, then report:

```bash
node scripts/bench-run.mjs --ref HEAD --repo <you>/delivery-bench-scratch --reset-scratch --scenario orchestrate
node scripts/bench-run.mjs --ref HEAD --repo <you>/delivery-bench-scratch --reset-scratch --scenario orchestrate --orchestrate-args "--small-effort medium"
node scripts/bench-report.mjs
```

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

**What it runs.** For each ref and run, `bench-run.mjs` exports the ref with `git archive`,
without the files in `HIDDEN_FROM_AGENTS`, and uses that as the plugin (`claude --plugin-dir`, which takes
precedence over an installed `delivery` plugin). It copies `bench/fixture-repo/` — a tiny
Node module with a `CLAUDE.md`, a test suite and a CI workflow that runs `npm test` — to a
temporary directory, resets the scratch repository (see Isolation above) and force-pushes the copy as its `main`. That is why
`--reset-scratch` must be passed: it says you know the scratch repository is reset. Then:

- **Scenario 3, `orchestrate`.** It files the four canned issues in `bench/issues/` and runs
  one `claude -p "/delivery:orchestrate <n> --points <p>"` per issue:
  - **small**: 1 point, no risk label. This exercises the sonnet implementer and the light
    review.
  - **medium**: 3 points. This exercises the full review on the session model.
  - **trap**: 3 points. A planted requirement that the obvious implementation breaks: an
    emptied SKU's key must be deleted, not left at 0. It sits inside the acceptance criteria, as
    a trailing clause of the "subtracts `qty`" bullet, where a reviewer checking each criterion
    against the diff catches it. It used to sit only in a Notes paragraph, and no review caught
    it there. Since #94 moved it into the criteria, every implementer met it in all six runs of
    the N=3 replay on two refs, so no review blocked on it. It now measures the implementer, not
    review and fix.
  - **caller**: 3 points. The scenario that drives review → fix (#98). The issue asks for
    `lowStock` to return `[{ sku, qty }]` instead of a list of SKU strings. The natural change
    passes the fixture suite, but the unchanged `src/reorder.js` still reads each entry as a SKU,
    so the nightly reorder it builds for the supplier becomes `[object Object],NaN` lines. Its
    one test uses a stock with nothing low, so `npm test` stays green and CI passes. An
    implementer who checks the callers of the function it changes avoids it; a reviewer who
    checks backwards compatibility against the repository, not just the diff, finds it and
    blocks. It is a defect the PR introduces, not a pre-existing one, so the review procedure
    does not exclude it. `verify-plugin.mjs` applies that natural change to a copy of the
    fixture and checks both halves: the suite passes and `reorderLines` breaks.

  **Planted defects are hidden from the agents.** A planted defect is described in its issue
  file's front matter (`defect`, a note for maintainers; `defectLocations`, files with an
  optional `:start-end` line range; `defectKeywords`). Only the title, labels and body are
  filed, so no agent reads the front matter. The plugin under test is exported with `git
  archive`, so it has no git history, and `bench-run.mjs` leaves out every file that describes a
  planted defect (`HIDDEN_FROM_AGENTS`: `bench/`, this file, the bench scripts, and the verifier and its bench
  fixtures). The
  verifier exports the plugin and fails if any file in it still names one.
  `bench-run.mjs` records each call's planted defect in `meta.json`, where the report reads it.
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
- per scenario issue (`small`, `medium`, `trap`, `caller`), a separate table with:
  - **blocking**: how many runs' first review drew a blocking finding, of the runs reviewed
  - **planted defect**: how many runs had a blocking finding that named the issue's planted
    defect, of the runs whose findings were recorded. A finding names it when its location is
    one of the defect's files (inside the line range, if one is given), or its location or
    summary contains one of the keywords, ignoring case. `-` means the issue has no planted
    defect. A result from a ref that does not return `review` shows blocking by whether a fix
    ran, and the planted column as `n/a`.

  A run that blocks on something else counts as blocking but not as a hit. So the two columns
  together tell a review that found the planted defect from one that blocked for another
  reason. A miss can also mean the implementer updated `src/reorder.js` and there was no defect
  to find: read that run's PR diff before calling it a review miss.

  **The caller issue's trap rate is measured only by a paid replay, never by CI.** CI
  (`verify-plugin.mjs`) proves that the trap is real (the natural change passes the suite and
  breaks the caller), that the report counts it correctly on a synthetic results tree, and that
  the matcher can fail. How often an implementer falls into it and a review catches it is only
  known by running `bench-run.mjs` and reading this table, at `--runs 3` or more.
- for plan-epic, whether an epic was filed: the scratch repository gained issues across the
  call (the planner's own reply is free text and proves nothing)

A second table splits the same tokens by type: input, cache write, cache read and output, per
ref, scenario and phase, plus an `all` row. Read it to tell two kinds of change apart. A smaller
prompt footprint shows as fewer cache writes and cache reads. An effort change shows in output.
The totals in the first table mix the two.

A run whose call exited non-zero, timed out, or whose session could not be found is reported
with a `WARNING ... INCOMPLETE` line under the tables: its numbers are lower or vacuous, not
better. An orchestrate ref in which no run reached the Fix phase also gets a warning. In that
case no issue drew a blocking finding, so fix, re-review and the #49 check went unexercised,
and their `n/a` proves nothing.

Then come the behaviour checks, read from the transcripts. A check passes only if it passed in
every run it applied to:

| Check | What fails it |
|-------|---------------|
| #48 full review at `high` | a full review whose transcript records an effort other than `high` |
| #49 fix makes no new branch or PR | a Fix-phase agent running `git checkout -b`, `git switch -c`, `git branch <name>` or `gh pr create` |
| #51 no CLAUDE.md read | any agent's `Read` of `CLAUDE.md`, or a `cat`/`head`/`sed`… of it (it is already in context) |
| #51 no ask-user | any agent calling `AskUserQuestion` |

The last table is the highest turn count per agent type, per ref and scenario. The `maxTurns`
ceilings in `agents/*.md` are set from it (#97).

**Re-deriving `maxTurns`.** Run the replay with `--runs 3`, then `bench-report.mjs`, and take
the largest number in an agent's column across every row of that table. The current values
come from the N=3 replay recorded on #86 (6 runs per scenario): code-issue 13, code-review 7,
code-planner 9, research 8. `research` is set to 30. **Do not set `code-review` from the
replay:** 0.9.0 set it to 30 from the fixture's 7 and cut off about 1 review in 7 on real
repositories, where completed reviews took up to 64 turns (p95 38, p99 49, over 1,143
reviews). A review stopped by its cap returns nothing, so the workflow gets no result.
`code-review` is now 130, twice the highest observed on real runs. Re-derive it from real
session transcripts (`~/.claude/projects/*/*/subagents/workflows/*/agent-*.jsonl`, whose
`.meta.json` names the agent type), not from the fixture. `ui-vision` stays at 80 because no scenario drives a browser,
so there is no data for it. When you change a value, update the comment above it in the
agent's frontmatter: the verifier wants it to name the replay (`bench replay on #<issue>`)
and either `highest observed <n>` or `no data yet`, and fails one that still says
provisional. Lower a
ceiling only on runs from real repositories: a fixture's maximum is a floor for real work,
not an estimate of it.

**What it proves.** On this fixture, with these four issues and this topic, how many tokens
each ref spent per delivered issue and per phase, what its reviews found, and whether the
behaviours 0.8.0 fixed stayed fixed. The transcripts are kept with the results, so every
number can be traced to the agent that produced it.

**What it does not prove.** How the plugin performs on your repository. A small fixture has a
small CLAUDE.md and small files, so it understates the per-dispatch cost a large project pays.
At N=1, one run is one sample: the caller issue may or may not draw a blocking finding (the
report warns when no issue did), and token counts vary run to run. Repeat with `--runs 3` before reading a difference as real. The report
reads fields (`findingCounts`, recorded effort) that may be missing from an older ref's
results; where one is missing it says `n/a` rather than guessing. 0.7.1 already returns
`findingCounts` and `reviewScope`, so its full reviews are checked by #48 and will show FAIL
there if they did not run at `high`.

The report reads results from `bench-run.mjs`'s own results tree and the persisted transcripts
rather than through `cost-report.mjs`: it needs per-agent turns, effort and tool calls, which
the result JSON does not carry.
