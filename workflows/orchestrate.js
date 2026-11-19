export const meta = {
  name: 'orchestrate',
  description: 'Run GitHub issues through implement -> review -> fix -> re-review, one PR each',
  whenToUse:
    'Type /delivery:orchestrate <issue number> to take an issue end to end without naming agents; /delivery:orchestrate 412 413 415 to have one implementer work related issues in turn (one PR each, each reviewed); /delivery:orchestrate 412 413 ; 500 501 to run independent batches concurrently in separate git worktrees. Optional size hint: --points N or --small; --small-model sonnet|inherit|haiku picks the model of the small tier (default sonnet); --small-effort medium|high picks the effort of the small-tier implementer only (default high; medium is unmeasured, for a replay to compare). /delivery:orchestrate --pr 88 89 takes pull requests that already exist through review, fix and re-review with no implement phase. /delivery:orchestrate --epic 47 reads the epic\'s open sub-issues and their dependencies and builds the batches itself. Opt-in and unmeasured: --triage reads each issue\'s story points on haiku first so the size routing applies without a hint; --per-issue gives every issue in a batch its own implementer instead of one shared context; --e2e has delivery:e2e-test add Playwright specs to a UI-labelled PR before its review. Experimental --batch-review reviews a batch of PRs in one review instead of one per PR (cheaper, less independent; ignored for a batch with a risk label). Unlike dispatching an implementer by hand, the review phase cannot be skipped: it is a step in this script rather than something a model has to remember. Works in any repository — the constraints come from the project\'s own CLAUDE.md, not from this file. Stops before merging.',
  phases: [
    { title: 'Triage', detail: 'only with --triage or --epic: delivery:triage reads points, labels and dependencies' },
    { title: 'Implement', detail: 'delivery:code-issue takes each issue in the batch to a green PR' },
    { title: 'E2E tests', detail: 'only with --e2e, for a UI-labelled PR' },
    { title: 'Review', detail: 'delivery:code-review reads each PR independently, scoped to its risk' },
    { title: 'Fix', detail: 'only if review returned a blocking finding' },
    { title: 'Re-review', detail: 'cycle 2 of a maximum 2' },
  ],
}

// Why a workflow and not just an agent: an agent cannot be invoked directly.
// Claude Code has no `/agent-name` syntax -- dispatch is purely a model reading
// `description` fields and choosing. That is exactly why the REVIEW phase kept
// being skipped in practice, and why writing the pipeline into a CLAUDE.md
// helped but could not guarantee anything. A workflow is a command the user
// types, and the sequence below is code rather than an intention.

// This plugin is project-agnostic, so it hardcodes no project's rules. It does
// not need to carry them either: every workflow subagent starts with the
// repository's CLAUDE.md already injected, so quoting it into the prompt (as an
// earlier Preflight phase did) paid for the same text two or three times per
// dispatch. Only what is NOT auto-loaded -- AGENTS.md and .claude/delivery.md --
// has to be named. The procedure itself (mutation-tested TDD, gates, publishing
// mechanics) is preloaded into each agent by its `skills:` frontmatter, so the
// prompts below refer to it as already in context and never name its slash
// command: a slash name cues a Skill call that would load it a second time.
const RULES = `
Ground rules for this dispatch:

1. The project's rules win over anything in this prompt. Your procedure's Step 0 says how to
   treat CLAUDE.md, AGENTS.md and a repository with neither.
2. Orient as your procedure's Step 1 describes: one batched call, which includes
   \`cat .claude/delivery.md 2>/dev/null\` (its absence is normal), then one response of
   parallel reads.
3. Where the project states no gate, infer it from the CI workflow and say in your report
   what you inferred.
4. Do not merge. Merging is the caller's decision.
`.trim()

// Structured output replaces a separate triage agent. A regex over free-text
// review prose is fragile -- reviewers phrase blockers several ways, and a missed
// match would silently skip the fix phase -- but a schema makes the reviewer
// commit to a boolean at the tool-call layer, with validation and retry.
const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    pr: { type: 'integer', description: 'The pull request number reviewed' },
    recommendation: { type: 'string', description: 'The Recommendation: line you published' },
    blocking: {
      type: 'boolean',
      description: 'true if at least one finding should be fixed before merge',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'nit'] },
          location: { type: 'string', description: 'file:line, or "general"' },
          summary: { type: 'string', description: 'The finding and why it matters' },
          blocking: { type: 'boolean' },
          confidence: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description: 'How sure you are, after checking, that the finding is real and this PR introduced it (0-100)',
          },
          resolvableBy: {
            type: 'string',
            enum: ['author', 'owner', 'wait'],
            description:
              'Who can clear it. author: a change to this PR (code, tests, docs, its body). owner: only a human can -- an ' +
              'approval, a ruling, a check on a real device. wait: nothing to change, only time -- CI still running, an ' +
              'outage. Leave it out for author.',
          },
        },
        required: ['severity', 'location', 'summary', 'blocking', 'confidence'],
      },
    },
    verification: {
      type: 'string',
      description: 'What you ran to verify the author\'s claims, and what you could not check',
    },
    headSha: {
      type: 'string',
      description: 'The PR head commit you reviewed, from gh pr view --json headRefOid',
    },
    durableFinding: {
      type: 'string',
      description:
        'Optional: a lesson a future reviewer could not derive by reading the code -- a defect class that ' +
        'recurs in this project, a check that keeps paying, a fixture pattern that hides a real hole -- stated ' +
        'plainly so the caller can record it. Leave it out for a one-off finding: the review is already its record. ' +
        'Most reviews have none.',
    },
  },
  required: ['recommendation', 'blocking', 'findings', 'verification'],
}

// The batch review (--batch-review) returns one REVIEW_SCHEMA entry per PR it covered, each
// with its own pr number, so every PR still gets its own blocking decision.
const BATCH_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    reviews: {
      type: 'array',
      description: 'One entry per pull request reviewed, each the review of that PR alone',
      items: { ...REVIEW_SCHEMA, required: ['pr', ...REVIEW_SCHEMA.required] },
    },
  },
  required: ['reviews'],
}

// Who can clear a finding. A blocker only a human can clear (an owner's approval, a check on a
// real device) or only time can (CI still running, an outage) gains nothing from a fix pass:
// over 630 real runs, at least 128 of 557 fix cycles were started by such blockers alone, and
// each paid for a fix and a re-review that could not change the outcome. Unknown means author.
const authorCanFix = (f) => !f?.resolvableBy || f.resolvableBy === 'author'

const formatReview = (r) =>
  [
    `PR: ${r.pr ?? 'unknown'}`,
    r.recommendation,
    ...r.findings.map(
      (f) => `- [${f.blocking ? 'BLOCKING' : 'non-blocking'}${f.blocking && !authorCanFix(f) ? `, ${f.resolvableBy}'s to clear, not the author's` : ''}] ${f.severity} ${f.location}: ${f.summary}`,
    ),
    `Verification: ${r.verification}`,
  ].join('\n')

// The fix agent answers in structure too, so the re-reviewer gets one line per
// finding instead of the author's prose -- and a declined finding cannot vanish
// between the fix and the re-review.
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    changed: {
      type: 'array',
      description: 'One entry per finding you fixed',
      items: {
        type: 'object',
        properties: {
          finding: { type: 'string', description: 'The finding, as the review stated it' },
          fix: { type: 'string', description: 'What you changed' },
          test: { type: 'string', description: 'The test that proves it, which you saw fail without the fix' },
        },
        required: ['finding', 'fix', 'test'],
      },
    },
    declined: {
      type: 'array',
      description: 'One entry per finding you did not take',
      items: {
        type: 'object',
        properties: {
          finding: { type: 'string' },
          reason: { type: 'string', description: 'Why you did not take it' },
        },
        required: ['finding', 'reason'],
      },
    },
    gates: {
      type: 'object',
      properties: {
        passed: { type: 'boolean', description: 'true if every gate you re-ran passed' },
        pushed: { type: 'boolean', description: 'true if the fixes are pushed to the PR branch' },
        detail: { type: 'string', description: 'Which gates ran, and anything that failed' },
      },
      required: ['passed', 'pushed'],
    },
    filesChanged: { type: ['integer', 'null'], description: 'Files your fix commits changed, from git diff --shortstat <head before your fix>..HEAD' },
    linesChanged: { type: ['integer', 'null'], description: 'Insertions + deletions of your fix commits, from the same command' },
  },
  required: ['changed', 'declined', 'gates'],
}

// Runs after the fix is pushed and before the re-review, so it must not throw on
// a partial result: a TypeError here would skip the re-review entirely. A missing
// field is named as "(not reported)" so the re-reviewer checks the branch itself.
const NR = '(not reported)'
const formatFix = (f) => {
  if (!f) return 'The fix agent did not return a result. Check the PR branch for what, if anything, was pushed.'
  const g = f.gates ?? {}
  return [
    ...(Array.isArray(f.changed)
      ? f.changed.map((c) => `- fixed: ${c?.finding ?? NR} — ${c?.fix ?? NR} (test: ${c?.test ?? NR})`)
      : [`- fixed: ${NR}`]),
    ...(Array.isArray(f.declined)
      ? f.declined.map((d) => `- declined: ${d?.finding ?? NR} — ${d?.reason ?? NR}`)
      : [`- declined: ${NR}`]),
    `Gates passed: ${g.passed ?? NR}; pushed: ${g.pushed ?? NR}` + (g.detail ? ` (${g.detail})` : ''),
  ].join('\n')
}

// Treat the review as blocking if EITHER the top-level flag or any single
// finding says so. Disagreement between the two should err towards a fix pass.
const isBlocking = (r) => Boolean(r.blocking || r.findings.some((f) => f.blocking))
// A fix pass is worth dispatching only if the author can clear something: a blocking finding
// that is the author's, or a top-level `blocking` with no blocking finding to say whose it is.
const authorCanUnblock = (r) => {
  const blockers = r.findings.filter((f) => f.blocking)
  return blockers.length ? blockers.some(authorCanFix) : Boolean(r.blocking)
}
const awaitedBy = (r) => [...new Set(r.findings.filter((f) => f.blocking && !authorCanFix(f)).map((f) => f.resolvableBy))].sort()
// What the fix agent is given: every blocking finding, and the non-blocking ones at medium or
// above. `low` and `nit` stay on the PR as inline comments for a human. Over 1,589 real reviews,
// 81% of 8,615 findings were low or nit, and the fix agent wrote 1,384 declines against 1,356
// changes: reading and answering them was most of what a fix pass did besides the fix.
const FIX_SEVERITIES = ['critical', 'high', 'medium']
const forFix = (r) => {
  const kept = r.findings.filter((f) => f.blocking || FIX_SEVERITIES.includes(f.severity))
  return [{ ...r, findings: kept }, r.findings.length - kept.length]
}

// Confidence filter. A false-positive finding costs a fix pass and a re-review, so a
// NON-blocking finding the reviewer itself rates below this confidence is dropped before the
// fix agent sees it, and counted in the result as suppressedFindings rather than discarded
// silently. A blocking finding is never dropped, whatever its confidence: suppressing a real
// blocker costs more than any fix cycle it saves. A finding with no confidence is kept, since
// unknown is not low.
// The value 50 was measured by the #92 eval matrix (docs/benchmarks.md, "Results at #92"): over
// 2,481 findings from haiku, sonnet and the session model, no seeded defect would have been lost
// at 30, 50 or 70, and 50 drops 36 of 234 findings on clean changes. 70 was lossless too but
// would also drop 621 of 1,410 findings whose truth the eval does not know, so it stays at 50.
// Raise it, or extend it to blocking findings, only with eval data that labels those findings.
const CONFIDENCE_THRESHOLD = 50
const lowConfidence = (f) => !f?.blocking && Number.isFinite(f?.confidence) && f.confidence < CONFIDENCE_THRESHOLD
const dropLowConfidence = (r) => {
  if (!r || !Array.isArray(r.findings)) return [r, 0]
  const kept = r.findings.filter((f) => !lowConfidence(f))
  return [{ ...r, findings: kept }, r.findings.length - kept.length]
}

// Finding counts by severity, read from the structured output rather than the prose,
// so the effect of a cheaper re-review on what it finds can be measured.
const SEVERITIES = REVIEW_SCHEMA.properties.findings.items.properties.severity.enum
const countBySeverity = (r) =>
  r && Array.isArray(r.findings)
    ? Object.fromEntries(SEVERITIES.map((s) => [s, r.findings.filter((f) => f?.severity === s).length]))
    : null

// Kept in step by hand: this helper is duplicated on purpose in orchestrate.js and plan-epic.js,
// because workflow scripts cannot import each other. Change both copies together.
// Output tokens per phase, as budget.spent() deltas around each agent() call. The
// budget pool is shared by the whole turn, so when batches run concurrently a delta
// also counts the other batches' agents. A runtime without `budget` (or one whose
// spent() fails) reports null rather than throwing: measurement must never cost a review.
const spentNow = () => {
  try {
    return typeof budget !== 'undefined' && budget && typeof budget.spent === 'function' ? budget.spent() : null
  } catch {
    return null
  }
}
const metered = async (call) => {
  const before = spentNow()
  const out = await call()
  const after = spentNow()
  return [out, before == null || after == null ? null : after - before]
}

// Model tiering lives here, in the script, and NOT in agent frontmatter. No agent
// sets `model:` at all: a frontmatter pin applies however the agent is reached and
// is invisible to the caller (a pinned research agent once dropped an opus-driven
// run to sonnet for its whole phase). Not even `model: inherit`: since Claude Code
// v2.1.251 an explicit frontmatter `model`, `inherit` included, takes precedence over
// the CLAUDE_CODE_SUBAGENT_MODEL environment variable, while an omitted field falls
// through to that variable and then to the main conversation's model
// (code.claude.com/docs/en/sub-agents, "Choose a model"). A choice made here applies
// only to this pipeline, is decided by code, and is logged on every run; a `model`
// passed per call still takes precedence over the variable.
//
// INHERIT means "omit `model`", i.e. the variable if set, otherwise the session model. Aliases
// rather than model IDs, so the plugin tracks new releases without an edit.
const INHERIT = null
const SONNET = 'sonnet'
// The small tier -- a small issue's implementer, the light review, the fix after a full
// review and the confirming re-review -- runs on SMALL, chosen with --small-model
// (sonnet | inherit | haiku; default sonnet, so a run without the flag is unchanged). It is
// an argument rather than a plugin userConfig option because a workflow script can read
// only `args`: `${user_config.KEY}` is substituted in skill, agent, hook, MCP and LSP
// content, not in workflow scripts (code.claude.com/docs/en/plugins-reference, "Reference a
// saved value"). On Bedrock and Google Cloud's Agent Platform the `sonnet` alias resolves to
// Sonnet 4.5 and `haiku` to Haiku 4.5, and on Foundry `sonnet` is Sonnet 4.5
// (code.claude.com/docs/en/model-config), which is why the choice is the caller's.
const SMALL_MODELS = { sonnet: SONNET, inherit: INHERIT, haiku: 'haiku' }
const modelOpt = (m) => (m ? { model: m } : {})
const modelName = (m) => m || 'session model'
// effortOpt(INHERIT) would omit `effort` and report "inherit", but this pipeline
// passes every phase's effort explicitly (see the effort rule below).
const HIGH = 'high'
const MEDIUM = 'medium'
const effortOpt = (e) => (e ? { effort: e } : {})
const effortName = (e) => e || 'inherit'

// Cost model. On a repository with a large CLAUDE.md, every dispatched agent pays
// for it before doing any work, so the number of agents per issue -- and the tier
// each runs on -- dominates the bill. Hence: no separate sizing agent (the
// implementer reads the issue anyway and reports its points and labels as
// structured output), one implementer per batch of issues rather than one per
// issue, and a review whose depth follows the risk of the change.

const SMALL_POINTS = 2
const RISKY_LABEL = /secur|auth|migrat|breaking|payment|billing|privacy|infra|data-loss/i
// A light review is only for a change that is small on every axis we can measure.
// Lines are additions + deletions as GitHub counts them, so a lockfile or a
// generated file counts too; that errs towards the full review, which is the
// direction to err in.
const LIGHT_REVIEW_MAX_FILES = 5
const LIGHT_REVIEW_MAX_LINES = 150

// The implementation is routed on the caller's size hint, because nothing has read
// the issue yet and paying an agent just to read it cost more than it saved. No
// hint means the session model: an unknown size is never a reason to use a
// cheaper model.
// `small` marks the small tier, whatever model --small-model gave it (inherit included), so
// that --small-effort follows the tier rather than the model.
const routeImplement = (hint) => {
  if (hint.small) return { small: true, model: SMALL, why: 'caller hint --small' }
  if (hint.points == null) return { small: false, model: INHERIT, why: 'no size hint' }
  const from = hint.fromTriage ? 'triage read' : 'caller hint'
  if (hint.points <= SMALL_POINTS) return { small: true, model: SMALL, why: `${from} ${hint.points} story points` }
  return { small: false, model: INHERIT, why: `${from} ${hint.points} story points` }
}

// The review is routed on facts the implementer reported from GitHub -- the
// issue's own Story Points line and labels, and the PR's diff size -- never on
// the caller's hint or a model's impression. Anything unknown means the full
// review on the session model.
const routeReview = (it) => {
  const full = (why) => ({ light: false, model: INHERIT, why })
  if (it.storyPoints == null) return full('no story points on the issue')
  if (it.storyPoints > SMALL_POINTS) return full(`${it.storyPoints} story points`)
  if (!Array.isArray(it.labels)) return full('labels unknown')
  const risky = it.labels.filter((l) => RISKY_LABEL.test(l))
  if (risky.length) return full(`risk label ${risky.join(', ')}`)
  if (it.filesChanged == null || it.linesChanged == null) return full('diff size unknown')
  if (it.filesChanged > LIGHT_REVIEW_MAX_FILES || it.linesChanged > LIGHT_REVIEW_MAX_LINES) {
    return full(`diff of ${it.filesChanged} files / ${it.linesChanged} lines is over the light-review limit`)
  }
  return {
    light: true,
    model: SMALL,
    why: `${it.storyPoints} story points, no risk label, ${it.filesChanged} files / ${it.linesChanged} lines`,
  }
}

// After a review, the work is narrow -- the findings spell out the fix -- so the
// fix drops to sonnet, unless sonnet did the implementing and still produced
// blocking findings: that is evidence the task was harder than it looked, so the
// fix escalates to the session model rather than asking sonnet to try again.
const fixModel = (implementedOn) => (SMALL !== INHERIT && implementedOn === SMALL ? INHERIT : SMALL)
// The re-review only confirms that listed findings are gone, so it runs on
// sonnet -- unless the first review was the light one. A small change that a
// light review still blocked was misjudged as low-risk, and cycle 2 is its first
// full-scope look, so that re-review escalates to the session model.
const rereviewModel = (route) => (route.light ? INHERIT : SMALL)
// Effort. Medium effort was measured (by Cloudflare) to lose real findings for
// quality and performance reviewers, so the implementer and the first full review
// pass `high` explicitly. They do not inherit: Claude Code's default effort on Opus
// 5.5 is `medium` (code.claude.com/docs/en/model-config, "Model default"), so in
// most sessions "inherit" would mean exactly the medium this rule exists to avoid.
// Only the fix, whose findings spell out the work, and the confirming re-review
// drop to medium. A re-review escalated from a light review is that change's first
// full-scope look, so it is `high` too. Every phase's effort is therefore explicit,
// and the result records the level passed, never "inherit".
const IMPLEMENT_EFFORT = HIGH
const REVIEW_EFFORT = HIGH
// The one exception is --small-effort (#96): the small tier's implementer may run at medium,
// because a small issue gains least from high and the Implement phase is most of what high
// cost. It is UNMEASURED, so the default stays high until a replay (bench-run.mjs
// --orchestrate-args) compares the two. Nothing else follows it: reviews, the fix, the
// re-reviews and every non-small implementer keep the effort above.
const implementEffort = (route) =>
  route.small
    ? { effort: SMALL_EFFORT, why: `small tier (${route.why}), ${smallEffortFlag ? `--small-effort ${smallEffortFlag[1]}` : 'default high, no --small-effort'}` }
    : { effort: IMPLEMENT_EFFORT, why: `not the small tier (${route.why}), always high` }
const FIX_EFFORT = MEDIUM
const rereviewEffort = (route) => (route.light ? HIGH : MEDIUM)

const LIGHT_SCOPE = `
Review scope: LIGHT. This change was routed to a light review because it is small and
carries no risk label. Do Step 1 (orient), Step 2 (requirements), Step 4 (security) and
Step 5 (correctness and code quality) restricted to the changed lines, and Step 7 (tests);
then publish (Step 9). Skip Step 3 (design), Step 6 (performance) and Step 8
(documentation), and say in the review's "Scope of this review" section that they were
skipped and why. If the diff touches authentication, authorisation, secrets, payments,
data migration or anything destructive, do the full review procedure instead and say so.
In Step 1, read the diff plus only the changed files you need to judge the changed lines,
not every changed file in full.
`.trim()

const ISOLATED = `
You are working in your own git worktree. Other agents are working on other issues in
sibling worktrees of the same repository at the same time. Stay inside your worktree and
never remove, prune or touch another one. A branch can be checked out in only one worktree
at a time, so: inspect a PR with \`gh pr checkout <number> --detach\`; to add commits to an
existing PR branch, work on that detached HEAD and push with \`git push origin
HEAD:<branch>\`; and once you have pushed a branch you created, run \`git checkout
--detach\` so that the branch is free for the agents that review and fix it.
`.trim()

// Every dispatch for one item is labelled by its issue number (or its PR when it
// has no issue), so the log reads as one line of work per issue.
const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      description: 'One entry per issue you worked, in the order you worked them',
      items: {
        type: 'object',
        properties: {
          issue: { type: ['integer', 'null'], description: 'The issue number (the one you filed, for a description)' },
          pr: { type: ['integer', 'null'], description: 'The pull request you opened for it, or null if you opened none' },
          storyPoints: {
            type: ['integer', 'null'],
            description: 'The number on the issue body\'s "Story Points" line, exactly as written; null if there is none. Do not estimate',
          },
          labels: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Every label name on the issue, from gh; null if you could not read them',
          },
          filesChanged: { type: ['integer', 'null'], description: 'The PR\'s changedFiles, from gh pr view' },
          linesChanged: { type: ['integer', 'null'], description: 'The PR\'s additions + deletions, from gh pr view' },
          headRefName: { type: ['string', 'null'], description: 'The PR\'s head branch, from gh pr view --json headRefName; null if you opened no PR' },
          report: {
            type: 'string',
            description: 'What you built, coverage before/after, the mutations that proved your tests can fail, defects found, anything deferred',
          },
        },
        required: ['issue', 'pr', 'storyPoints', 'labels', 'filesChanged', 'linesChanged', 'headRefName', 'report'],
      },
    },
  },
  required: ['issues'],
}

// ------------------------------------------------------------------ arguments
//
//   /delivery:orchestrate 412                    one issue
//   /delivery:orchestrate 412 413 415            one batch: one implementer, a PR per issue
//   /delivery:orchestrate 412 413 ; 500 501      two batches, run concurrently in worktrees
//   /delivery:orchestrate 412 --points 2         size hint for the implementation
//   /delivery:orchestrate 412 413 --small        (hints apply to their own batch)
//   /delivery:orchestrate make the filter honour a date range
//
// A bare number (optionally #-prefixed) is an issue; anything else is a
// description, and the implementer files the issue first so the work still has a
// record. Interpolating `issue #${raw}` unconditionally produces `issue #make the
// audit filter...`, which reads as a real reference and is not one.
const raw = (Array.isArray(args) ? args.join(' ') : args ? String(args) : '').trim()

// --small-model applies to the whole run, so it is taken out before batches are split. An
// unknown or missing value stops the run here: a silent fallback would run the small tier on
// a model the caller did not choose.
const smallFlag = /(?:^|\s)--small-model(?:=|\s+)(\S+)/.exec(raw)
if (/(?:^|\s)--small-model(?=[\s=]|$)/.test(raw)
  && !(smallFlag && Object.prototype.hasOwnProperty.call(SMALL_MODELS, smallFlag[1]))) {
  throw new Error(
    `--small-model must be one of ${Object.keys(SMALL_MODELS).join(', ')} ` +
      `(got ${smallFlag ? JSON.stringify(smallFlag[1]) : 'no value'}). Nothing was dispatched.`,
  )
}
const SMALL = smallFlag ? SMALL_MODELS[smallFlag[1]] : SONNET
if (smallFlag) log(`Small tier (small implementations, light reviews, fixes, confirming re-reviews) runs on ${modelName(SMALL)} (--small-model ${smallFlag[1]}).`)
// --small-effort is whole-run too, and fails the same way: an unknown value is an error, never
// a silent high. Only the implementer of a small-tier batch follows it (implementEffort above).
const SMALL_EFFORTS = { medium: MEDIUM, high: HIGH }
const smallEffortFlag = /(?:^|\s)--small-effort(?:=|\s+)(\S+)/.exec(raw)
if (/(?:^|\s)--small-effort(?=[\s=]|$)/.test(raw)
  && !(smallEffortFlag && Object.prototype.hasOwnProperty.call(SMALL_EFFORTS, smallEffortFlag[1]))) {
  throw new Error(
    `--small-effort must be one of ${Object.keys(SMALL_EFFORTS).join(', ')} ` +
      `(got ${smallEffortFlag ? JSON.stringify(smallEffortFlag[1]) : 'no value'}). Nothing was dispatched.`,
  )
}
const SMALL_EFFORT = smallEffortFlag ? SMALL_EFFORTS[smallEffortFlag[1]] : HIGH
if (smallEffortFlag) log(`Small-tier implementers run at ${SMALL_EFFORT} effort (--small-effort ${smallEffortFlag[1]}, unmeasured); every other phase keeps its effort.`)
// --batch-review (cheap mode, EXPERIMENTAL, off by default) reviews each batch of two or more
// PRs in ONE review dispatch instead of one per PR. It trades the independence of a per-PR
// review for cost, which is why it is opt-in: without it, every PR gets its own review. It is
// ignored for a batch where any issue carries a risk label, or whose labels are unknown. A PR
// the batch review blocks still gets its own fix and re-review. The #92 eval compares it with
// per-PR review (evals/batch-three-prs, evals/per-pr-three-prs): at N=3 its recall matched on
// haiku and the session model but not on sonnet, so it stays experimental. The graduation
// criterion is in docs/benchmarks.md.
const BATCH_REVIEW = /(?:^|\s)--batch-review(?=\s|$)/.test(raw)
if (BATCH_REVIEW) log('Cheap mode (--batch-review, EXPERIMENTAL): a batch of PRs with no risk label is reviewed once, not once per PR.')
// Whole-run switches added with the 630-run cost pass. Each is off by default, so a run without
// it dispatches exactly what it did before.
//   --pr          the numbers are pull requests that already exist: review, fix and re-review
//                 them with no implement phase (a PR left blocking, or one a person pushed).
//   --epic N      delivery:triage reads epic N's open sub-issues and their dependencies, and the
//                 batches are built from them, so nobody types the waves by hand.
//   --triage      delivery:triage (haiku) reads each issue's Story Points line first, so the
//                 size routing applies with no --points hint. UNMEASURED: 56% of 1,589 real PRs
//                 had no points line and 97% of implementers ran on the session model, but an
//                 earlier sizing agent cost more than it saved, so this stays opt-in.
//   --per-issue   one implementer per issue of a batch, in turn, instead of one for the batch.
//                 UNMEASURED: a real implementer's context reaches a median 385k tokens by the
//                 end of ONE issue, and every later turn re-reads it, so a shared context looks
//                 dearer than a fresh start; a replay has to confirm it before it is the default.
//   --e2e         delivery:e2e-test adds Playwright specs to a UI-labelled PR before its review.
const hasFlag = (name) => new RegExp(`(?:^|\\s)--${name}(?=\\s|$)`).test(raw)
const PR_MODE = hasFlag('pr')
const TRIAGE = hasFlag('triage')
const PER_ISSUE = hasFlag('per-issue')
const E2E = hasFlag('e2e')
const epicFlag = /(?:^|\s)--epic(?:=|\s+)#?(\d+)(?=\s|$)/.exec(raw)
if (/(?:^|\s)--epic(?=[\s=]|$)/.test(raw) && !epicFlag) {
  throw new Error('--epic needs the epic\'s issue number, as in --epic 47. Nothing was dispatched.')
}
const EPIC = epicFlag ? Number(epicFlag[1]) : null
if (PR_MODE && EPIC != null) throw new Error('--pr and --epic cannot be combined: one names pull requests, the other issues. Nothing was dispatched.')
const target = raw.replace(/(^|\s)--small-(?:model|effort)(=|\s+)\S+/g, ' ').replace(/(^|\s)--batch-review(?=\s|$)/g, ' ')
  .replace(/(^|\s)--epic(=|\s+)#?\d+(?=\s|$)/g, ' ').replace(/(^|\s)--(?:pr|triage|per-issue|e2e)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()

const parseSegment = (text) => {
  // Commas are accepted as separators too: `412, 413` is a batch, not a description.
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  const hint = { points: null, small: false }
  const rest = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const eq = /^--points=(\d+)$/.exec(t)
    if (t === '--small') hint.small = true
    else if (eq) hint.points = Number(eq[1])
    else if (t === '--points' && /^\d+$/.test(tokens[i + 1] || '')) hint.points = Number(tokens[++i])
    else rest.push(t)
  }
  const issues = rest.length && rest.every((t) => /^#?\d+$/.test(t)) ? rest.map((t) => Number(t.replace(/^#/, ''))) : null
  // A description keeps its own punctuation; only the hint flags are taken out.
  const description = issues ? null : text.replace(/(^|\s)--small(?=\s|$)|(^|\s)--points(=|\s+)\d+(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim()
  return { hint, issues, description }
}

const segments = target.split(';').map((s) => s.trim()).filter(Boolean).map(parseSegment)
let lanes
if (PR_MODE && !(segments.length && segments.every((s) => s.issues))) {
  throw new Error('--pr takes pull request numbers only, as in --pr 88 89 (; separates concurrent batches). Nothing was dispatched.')
}
if (segments.length && segments.every((s) => s.issues)) {
  // An issue listed twice would get two implementers racing for one branch.
  const seen = new Set()
  lanes = segments
    .map((s) => ({
      hint: s.hint,
      issues: s.issues.filter((n) => (seen.has(n) ? (log(`#${n} is listed more than once; working it once.`), false) : seen.add(n))),
    }))
    .filter((l) => l.issues.length)
  // With --pr the numbers name pull requests, and no issue is implemented.
  if (PR_MODE) lanes = lanes.map((l) => ({ hint: l.hint, issues: [], existingPrs: l.issues }))
} else if (EPIC != null) {
  // The batches come from the epic's own sub-issues, read by the Triage phase below.
  if (target) log(`--epic ${EPIC}: the batches are built from the epic's sub-issues; "${target}" is ignored.`)
  lanes = []
} else {
  // A description may itself contain ';' -- only all-numeric segments are batches.
  const whole = parseSegment(target)
  lanes = [{ hint: whole.hint, issues: [], description: whole.description }]
}

if (!target && EPIC == null) {
  log(
    'No target given. Usage: /delivery:orchestrate <issue number> [more issue numbers] ' +
      '[; another batch] [--points N | --small] [--small-model sonnet|inherit|haiku] [--small-effort medium|high] ' +
      '[--triage] [--per-issue] [--e2e] [--batch-review]  or  /delivery:orchestrate --pr <PR number>...  or  ' +
      '/delivery:orchestrate --epic <epic number>  or  ' +
        '/delivery:orchestrate <what you want done>',
  )
}

// ------------------------------------------------------------------ triage
//
// One haiku dispatch at low effort, with --triage or --epic only. It reads what the script
// cannot: a workflow has agent() and no shell, so an issue's Story Points line, its state and
// its dependencies reach the routing only through an agent. It decides nothing; the code
// below does, from the facts it returns.
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      description: 'One entry per issue asked about, or per sub-issue of the epic',
      items: {
        type: 'object',
        properties: {
          issue: { type: 'integer' },
          state: { type: 'string', enum: ['open', 'closed'] },
          storyPoints: { type: ['integer', 'null'], description: 'The number on the body\'s "Story Points" line, exactly as written; null if there is none. Do not estimate' },
          labels: { type: 'array', items: { type: 'string' } },
          openPr: { type: ['integer', 'null'], description: 'An open pull request that already closes this issue, or null' },
          blockedBy: { type: 'array', items: { type: 'integer' }, description: 'Issue numbers its body says it depends on or is blocked by' },
          ownerGate: { type: ['string', 'null'], description: 'An acceptance criterion only a human can meet (an approval, a check on a real device), quoted; null if none' },
        },
        required: ['issue', 'state', 'storyPoints', 'labels', 'openPr', 'blockedBy', 'ownerGate'],
      },
    },
  },
  required: ['issues'],
}
const MAX_EPIC_LANES = 4
// Issues that depend on each other, directly or through others, share a batch and run in
// dependency order; unrelated groups become concurrent batches, folded into at most
// MAX_EPIC_LANES so an epic of twenty issues does not start twenty implementers at once.
const lanesFromEpic = (issues) => {
  const open = issues.filter((i) => i.state === 'open' && !i.openPr)
  const ids = new Set(open.map((i) => i.issue))
  const deps = new Map(open.map((i) => [i.issue, (Array.isArray(i.blockedBy) ? i.blockedBy : []).filter((d) => ids.has(d) && d !== i.issue)]))
  const group = new Map(open.map((i) => [i.issue, i.issue]))
  const find = (x) => (group.get(x) === x ? x : (group.set(x, find(group.get(x))), group.get(x)))
  for (const [n, ds] of deps) for (const d of ds) group.set(find(n), find(d))
  const groups = new Map()
  for (const n of ids) groups.set(find(n), [...(groups.get(find(n)) || []), n])
  const ordered = [...groups.values()].map((members) => {
    // Dependencies first; a cycle falls back to issue-number order for what is left.
    const done = [], left = new Set(members.sort((a, b) => a - b))
    while (left.size) {
      const ready = [...left].filter((n) => deps.get(n).every((d) => !left.has(d)))
      for (const n of ready.length ? ready : [[...left][0]]) { done.push(n); left.delete(n) }
    }
    return done
  }).sort((a, b) => a[0] - b[0])
  const folded = ordered.slice(0, MAX_EPIC_LANES)
  ordered.slice(MAX_EPIC_LANES).forEach((g) => folded.sort((a, b) => a.length - b.length)[0].push(...g))
  return folded.sort((a, b) => a[0] - b[0]).map((g) => ({ hint: { points: null, small: false }, issues: g }))
}
let triage = null
const asked = lanes.flatMap((l) => l.issues)
if (EPIC != null || (TRIAGE && asked.length)) {
  const [got, tokens] = await metered(() => agent(
    (EPIC != null
      ? `List the sub-issues of epic #${EPIC} in this repository and report the facts below for each one.`
      : `Report the facts below for ${asked.map((n) => `#${n}`).join(', ')} in this repository.`) +
      ` Follow your instructions exactly: read with \`gh\`, report what is written, estimate nothing, change nothing.`,
    { label: EPIC != null ? `triage:epic${EPIC}` : 'triage', phase: 'Triage', agentType: 'delivery:triage', schema: TRIAGE_SCHEMA, model: 'haiku', effort: 'low' },
  ))
  const facts = Array.isArray(got?.issues) ? got.issues.filter((i) => i && Number.isInteger(i.issue)) : null
  triage = { epic: EPIC, issues: facts, outputTokens: tokens }
  if (!facts) {
    log(EPIC != null
      ? `Triage of epic #${EPIC} did not return — nothing was implemented.`
      : 'Triage did not return — carrying on without it: no size routing, no closed-issue check.')
  } else {
    const fact = new Map(facts.map((i) => [i.issue, i]))
    if (EPIC != null) {
      lanes = lanesFromEpic(facts)
      for (const i of facts) {
        if (i.state !== 'open') log(`#${i.issue}: already closed — left out.`)
        else if (i.openPr) log(`#${i.issue}: PR #${i.openPr} is already open for it — left out. Run --pr ${i.openPr} to review that PR.`)
      }
      log(lanes.length
        ? `Epic #${EPIC}: ${lanes.length} batch(es) — ${lanes.map((l) => l.issues.map((n) => `#${n}`).join(' ')).join(' ; ')}.`
        : `Epic #${EPIC}: no open sub-issue without a PR — nothing to implement.`)
    } else {
      lanes = lanes.map((l) => ({ ...l, issues: l.issues.filter((n) => (fact.get(n)?.state === 'closed' ? (log(`#${n}: already closed — left out.`), false) : true)) }))
        .filter((l) => l.issues.length)
      for (const n of lanes.flatMap((l) => l.issues)) {
        if (fact.get(n)?.openPr) log(`#${n}: PR #${fact.get(n).openPr} is already open for it; the implementer is told.`)
      }
    }
    for (const l of lanes) {
      // A batch is sized by its largest issue, and only when every issue states its points and
      // the caller gave no hint: an unknown size is never a reason to use a cheaper model.
      const pts = l.issues.map((n) => fact.get(n)?.storyPoints)
      if (!l.hint.small && l.hint.points == null && pts.length && pts.every(Number.isInteger)) {
        l.hint = { ...l.hint, points: Math.max(...pts), fromTriage: true }
      }
      l.openPrs = l.issues.filter((n) => fact.get(n)?.openPr).map((n) => ({ issue: n, pr: fact.get(n).openPr }))
      for (const n of l.issues) {
        if (fact.get(n)?.ownerGate) log(`#${n}: needs its owner before merge, whatever the review finds — ${String(fact.get(n).ownerGate).replace(/\s+/g, ' ').slice(0, 200)}`)
      }
    }
  }
}

const parallelLanes = lanes.length > 1
if (parallelLanes) {
  log(
    `${lanes.length} batches — running them concurrently, each agent in its own git worktree ` +
      'so that no two of them share a checkout.',
  )
}

// ------------------------------------------------------------------ one batch

const subjectOf = (lane) =>
  lane.issues.length === 1
    ? `issue #${lane.issues[0]}`
    : lane.issues.length
      ? `issues ${lane.issues.map((n) => `#${n}`).join(', ')}`
      : lane.description
        ? `this request: ${lane.description}`
        : 'the work the caller described in conversation'

const implementPrompt = (lane, rules) => {
  const subject = subjectOf(lane)
  const order = lane.issues.length > 1
    ? `Work them one at a time, in this order, each one all the way to a green PR before ` +
      `starting the next. Each issue gets its own branch from the default branch and its own ` +
      `PR with \`Closes #<issue>\`; never combine two issues in one PR. If an issue genuinely ` +
      `depends on an earlier one in this list that is not merged yet, branch from that ` +
      `issue's branch instead and say so in the PR body. If one issue cannot be finished, ` +
      `report why and carry on with the next.`
    : lane.issues.length
      ? `Open a PR with \`Closes #${lane.issues[0]}\`. Watch CI to green.`
      : 'File a GitHub issue for this first, then open a PR that closes it — work without an ' +
        'issue leaves no record of why it was done. Watch CI to green.'
  return (
    `Implement ${subject} end to end in this repository, following the code-issue ` +
    `procedure (preloaded).\n\n${rules}\n\n${order}\n\n` +
    `For every issue, report as structured output, alongside your report:\n` +
    `- its labels and the number on its "Story Points" line, from ` +
    `\`gh issue view <issue> --json labels,body\` — exactly as written, null if there is no ` +
    `such line; do not estimate, the review is routed on these;\n` +
    `- the PR's size and branch, from \`gh pr view <pr> --json changedFiles,additions,deletions,headRefName\`: ` +
    `changedFiles, additions + deletions as linesChanged, and headRefName.`
  )
}

// --e2e. The label test is deliberately narrow: a UI word as a whole label segment.
const UI_LABEL = /(^|[^a-z])(ui|ux|frontend|front-end|client|web|design)([^a-z]|$)/i
const E2E_SCHEMA = {
  type: 'object',
  properties: {
    added: { type: 'boolean', description: 'true if you pushed at least one spec to the PR branch' },
    tests: { type: 'integer', description: 'How many tests you added' },
    uncovered: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria you could not cover, each with the reason' },
    note: { type: 'string', description: 'What you inferred about the setup, and why nothing was added if nothing was' },
  },
  required: ['added', 'tests', 'uncovered'],
}
const e2ePrompt = (it, isolated) =>
  `Write Playwright end-to-end tests for pull request #${it.pr}` + (it.issue ? `, opened for issue #${it.issue}` : '') +
  `, following your e2e-test procedure: one test at least for every acceptance criterion a browser can check. ` +
  (it.headRefName ? `The PR's head branch is \`${it.headRefName}\`. ` : `Read the PR's head branch with \`gh pr view ${it.pr} --json headRefName\`. `) +
  `Push the specs to that existing branch; open no new branch and no new PR, and do not merge.\n\n` +
  `No user is present: never stop to ask a question. Where your procedure says to ask, decide from the ` +
  `issue and the repository and say what you decided. The project's own rules (CLAUDE.md, and ` +
  `\`.claude/delivery.md\` if it exists) win over this prompt. If the project has no Playwright setup and ` +
  `the issue does not ask for one, add nothing and say so: scaffolding a test framework is not this PR's job.` +
  (isolated ? `\n\n${ISOLATED}` : '') +
  `\n\nReturn whether you added specs, how many tests, and every criterion you could not cover with the reason.`

// `batch`, when set, is this PR's entry from a batch review that already ran: the review step
// is not dispatched again, and the fix and re-review below run per PR exactly as they would
// after a per-PR review.
async function reviewOne(it, lane, implementModel, implementedAt, iso, rules, batch = null) {
  const tag = it.issue ?? `pr${it.pr}`
  const existing = Boolean(lane.existingPrs)
  const subject = it.issue ? `issue #${it.issue}` : existing ? 'the issue its body closes' : subjectOf(lane)
  const route = batch ? BATCH_ROUTE : routeReview(it)
  // A PR that already existed (--pr) has no implement phase to report a model or an effort for.
  const models = existing ? { review: route.model } : { implement: implementModel, review: route.model }
  const effort = existing ? { review: REVIEW_EFFORT } : { implement: implementedAt, review: REVIEW_EFFORT }
  // A batch review's tokens are the batch's, recorded on the lane, not split across its PRs.
  const outputTokens = batch ? {} : { review: null }
  log(
    `#${tag}: ${batch ? 'batch review' : route.light ? 'light review' : 'full review'} on ${modelName(route.model)} ` +
      `(${route.why}).`,
  )
  let [reviewed, reviewTokens] = batch ? [batch.review, null] : await metered(() => agent(
    `Review pull request #${it.pr}, opened for ${subject}, following the code-review ` +
      `procedure (preloaded).\n\n` +
      (route.light ? `${LIGHT_SCOPE}\n\n` : '') +
      `The implementer's summary, defects found and deferred work are in the PR body ` +
      `(\`gh pr view ${it.pr} --json body\`); read the change itself, not only that account.` +
      `\n\n${rules}\n\n` +
      `Publish the review to GitHub as the procedure describes, then return your ` +
      `recommendation and every finding with severity, file:line and whether it is blocking.`,
    {
      label: `review:${tag}`,
      phase: 'Review',
      agentType: 'delivery:code-review',
      schema: REVIEW_SCHEMA,
      ...modelOpt(route.model),
      ...effortOpt(effort.review),
      ...iso,
    },
  ))
  if (!batch) outputTokens.review = reviewTokens
  let suppressedFindings = 0
  if (reviewed) {
    let n
    ;[reviewed, n] = dropLowConfidence(reviewed)
    suppressedFindings += n
    if (n) log(`#${tag}: ${n} non-blocking finding(s) below confidence ${CONFIDENCE_THRESHOLD} suppressed.`)
  }
  const effortNames = () => Object.fromEntries(Object.entries(effort).map(([k, e]) => [k, effortName(e)]))
  const base = {
    issue: it.issue,
    pr: it.pr,
    implemented: it.report,
    reviewScope: route.light ? 'light' : 'full',
    reviewRouting: route.why,
    reviewedInBatch: Boolean(batch),
  }

  // A review that never came back is not a clean review. Stop loudly rather than
  // fall through to "no blocking findings" -- the failure this workflow exists to
  // prevent is a review phase that silently did not happen.
  if (!reviewed) {
    log(`#${tag}: review did not complete — PR #${it.pr} has NOT been reviewed.`)
    return {
      ...base,
      review: null,
      reviewCompleted: false,
      effort: effortNames(),
      outputTokens,
      note: 'The review phase did not return. Re-run the review before treating this PR as reviewed.',
    }
  }

  const blocking = isBlocking(reviewed)
  const reviewText = formatReview(reviewed)
  const fixable = blocking && authorCanUnblock(reviewed)
  const awaiting = blocking ? awaitedBy(reviewed) : []
  // The commit the review read, if it said so. It names the fix exactly: everything after it.
  const reviewedSha = typeof reviewed.headSha === 'string' && /^[0-9a-f]{7,40}$/i.test(reviewed.headSha.trim()) ? reviewed.headSha.trim() : null
  let fixed = null
  let rereviewed = null
  let withheldFromFix = 0
  let fixSize = null

  if (fixable) {
    models.fix = fixModel(implementModel)
    models.rereview = rereviewModel(route)
    effort.fix = FIX_EFFORT
    effort.rereview = rereviewEffort(route)
    log(
      `#${tag}: blocking findings — fix on ${modelName(models.fix)}` +
        (SMALL !== INHERIT && models.fix === INHERIT && implementModel === SMALL
          ? ` (escalated: the ${modelName(SMALL)} implementation did not pass review)`
          : '') +
        `, re-review on ${modelName(models.rereview)}` +
        (route.light ? ' (escalated: a light review found blocking findings, so cycle 2 is full scope).' : '.'),
    )
    // The fix pushes to the PR that exists. Its branch comes from the implementer's gh
    // read; if that was not reported, the agent is told to read it, never to guess one.
    const head = it.headRefName
      ? `The PR's head branch is \`${it.headRefName}\`.`
      : `Read the PR's head branch with \`gh pr view ${it.pr} --json headRefName\` before you start.`
    let fixInput
    ;[fixInput, withheldFromFix] = forFix(reviewed)
    ;[fixed, outputTokens.fix] = await metered(() => agent(
      `Fix the blocking findings from this code review of PR #${it.pr} for ${subject}, ` +
        `following the Fix mode section of the code-issue procedure (preloaded). ` +
        `${head} Push your fixes to that existing branch. Do not create a new branch or a ` +
        `new PR, and skip the steps Fix mode skips.\n\n` +
        `${formatReview(fixInput)}\n\n${rules}\n\n` +
        `Address every BLOCKING finding, and prove each fix with a test you have seen fail ` +
        `without it. For non-blocking ones, either take them or say why not — do not ` +
        `silently ignore them. Re-run the gates and push.` +
        (awaiting.length
          ? ` A blocker marked as the owner's to clear, or as waiting, is not yours: change ` +
            `nothing for it, never stand in for an approval or a result, and decline it with that reason.`
          : '') +
        (withheldFromFix
          ? ` ${withheldFromFix} low or nit finding(s) stay on the PR as comments for a person and are not listed here.`
          : '') +
        `\n\nReturn, as structured output, each finding you changed (with its test), each you ` +
        `declined (with the reason), whether the gates passed and the fixes are pushed, and the ` +
        `size of your fix (\`git diff --shortstat <head before your fix>..HEAD\`: files changed, and ` +
        `insertions + deletions as linesChanged).`,
      {
        label: `fix:${tag}`,
        phase: 'Fix',
        agentType: 'delivery:code-issue',
        schema: FIX_SCHEMA,
        ...modelOpt(models.fix),
        ...effortOpt(effort.fix),
        ...iso,
      },
    ))

    // A confirming re-review reads the files the findings name, on the small tier at medium
    // effort. That is the right depth for a fix the findings spelled out, and the wrong one for
    // a large fix: its code has never had a full-scope read. Real fix passes run from a median
    // 15k output tokens to 115k at p90, so a fix over the light-review limit is reviewed as
    // new code, on the session model at high effort. An unreported size changes nothing.
    fixSize = fixed && Number.isInteger(fixed.filesChanged) && Number.isInteger(fixed.linesChanged)
      ? { files: fixed.filesChanged, lines: fixed.linesChanged } : null
    const bigFix = Boolean(fixSize && !route.light
      && (fixSize.files > LIGHT_REVIEW_MAX_FILES || fixSize.lines > LIGHT_REVIEW_MAX_LINES))
    if (bigFix) {
      models.rereview = INHERIT
      effort.rereview = HIGH
      log(`#${tag}: the fix is ${fixSize.files} files / ${fixSize.lines} lines, over the light-review limit — re-review escalated to ${modelName(INHERIT)} at high effort, reading the fix as new code.`)
    }
    const sinceReview = reviewedSha
      ? ` The review read commit ${reviewedSha}: after checking the PR out, \`git diff ${reviewedSha}..HEAD\` is exactly what the author changed since.`
      : ''
    ;[rereviewed, outputTokens.rereview] = await metered(() => agent(
      `Re-review PR #${it.pr} for ${subject}, following the code-review procedure (preloaded). ` +
        `This is cycle 2 of a maximum 2 — be decisive and do not open new lines of inquiry ` +
        `that do not affect merge.` +
        (bigFix
          ? ` The fix is ${fixSize.files} files / ${fixSize.lines} lines, more than a confirming ` +
            `pass covers: besides checking each finding, review the fix's own diff as new code, ` +
            `with the security, correctness and test steps of the procedure.`
          : '') +
        sinceReview +
        (route.light
          ? ` The first review was a LIGHT one (no design, performance or documentation ` +
            `pass) and still found blocking problems, so this cycle is the change's first ` +
            `full-scope review: run every step of the procedure on the diff.`
          : '') +
        `\n\nOrient with one batched call (PR, diff, checks and .claude/delivery.md together), ` +
        (route.light
          ? `then read every changed file, in full, in one response of parallel reads.`
          : `then read the files the findings name in one response of parallel reads.`) +
        `\n\nThe original review:\n${reviewText}\n\nWhat the author then did:\n${formatFix(fixed)}\n\n` +
        `${rules}\n\n` +
        `Verify each blocking finding was ACTUALLY fixed, by running it rather than by ` +
        `reading the response. Publish as the procedure describes, then return what is still ` +
        `blocking, if anything.`,
      {
        label: `rereview:${tag}`,
        phase: 'Re-review',
        agentType: 'delivery:code-review',
        schema: REVIEW_SCHEMA,
        ...modelOpt(models.rereview),
        ...effortOpt(effort.rereview),
        ...iso,
      },
    ))
    if (rereviewed) {
      let n
      ;[rereviewed, n] = dropLowConfidence(rereviewed)
      suppressedFindings += n
    }
  } else if (blocking) {
    log(`#${tag}: blocked only on ${awaiting.map((w) => (w === 'wait' ? 'waiting (CI or an outage)' : 'its owner')).join(' and ')} — no fix or re-review: nothing here is the author's to change.`)
  } else {
    log(`#${tag}: no blocking findings — skipping fix and re-review.`)
  }

  return {
    ...base,
    review: reviewed,
    reviewCompleted: true,
    blockingFindings: blocking,
    fix: fixed,
    reReview: rereviewed,
    stillBlocking: rereviewed ? isBlocking(rereviewed) : null,
    // Blockers no fix pass can clear: 'owner' (a person must act) and/or 'wait' (CI, an outage).
    awaiting,
    reviewedSha,
    withheldFromFix,
    fixSize,
    models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, modelName(m)])),
    effort: effortNames(),
    outputTokens,
    findingCounts: { review: countBySeverity(reviewed), rereview: countBySeverity(rereviewed) },
    suppressedFindings,
  }
}

// A batch review is always full scope on the session model at high effort: it is the only
// look the PRs get before a fix, and it covers more than one change.
const BATCH_ROUTE = { light: false, model: INHERIT, why: 'covered by one batch review (--batch-review)' }

const reviewModeOf = (withPr) => {
  if (!BATCH_REVIEW) return { batch: false, why: 'per-PR review (default)' }
  if (withPr.length < 2) return { batch: false, why: '--batch-review has no effect on a single PR' }
  const unknown = withPr.filter((i) => !Array.isArray(i.labels))
  if (unknown.length) return { batch: false, why: `--batch-review ignored: labels unknown for ${unknown.map((i) => `#${i.issue ?? '?'}`).join(', ')}` }
  const risky = withPr.flatMap((i) => i.labels.filter((l) => RISKY_LABEL.test(l)).map((l) => `${l} on #${i.issue ?? '?'}`))
  if (risky.length) return { batch: false, why: `--batch-review ignored: risk label ${risky.join(', ')}` }
  return { batch: true, why: `--batch-review: ${withPr.length} PRs, no risk label` }
}

const batchReviewPrompt = (withPr, rules) =>
  `Review these pull requests from one batch in a single pass, following the code-review ` +
  `procedure (preloaded) at full scope for each: ` +
  withPr.map((i) => `PR #${i.pr}${i.issue ? ` (issue #${i.issue})` : ''}`).join(', ') + `.\n\n` +
  `Judge each PR on its own diff and its own issue: a finding belongs to the PR that ` +
  `introduced it. Each implementer's summary is in its PR body (\`gh pr view <pr> --json body\`); ` +
  `read the change itself, not only that account.\n\n${rules}\n\n` +
  `Publish a separate review on EACH pull request, with that PR's findings and its own ` +
  `Recommendation: line, as the procedure describes. Then return one entry per PR, with its ` +
  `pr number, recommendation and every finding with severity, file:line and whether it is blocking.`

async function runLane(lane, isolated) {
  // Isolation is all or nothing per batch: concurrent batches sharing one checkout
  // would switch branches under each other, so every agent in a concurrent batch
  // gets its own worktree. A single batch runs in the caller's checkout as before.
  const iso = isolated ? { isolation: 'worktree' } : {}
  const rules = isolated ? `${RULES}\n\n${ISOLATED}` : RULES
  // --pr: the pull requests exist already, so there is nothing to implement. Each is reviewed
  // as any PR is; with no issue facts to route on, that is the full review on the session model.
  if (lane.existingPrs) {
    log(`Review existing pull request(s) ${lane.existingPrs.map((n) => `#${n}`).join(', ')} — no implement phase (--pr).`)
    const prs = []
    for (const n of lane.existingPrs) {
      const it = { issue: null, pr: n, storyPoints: null, labels: null, filesChanged: null, linesChanged: null, headRefName: null, report: null }
      prs.push(await reviewOne(it, lane, INHERIT, null, iso, rules))
    }
    return {
      issues: [], existingPrs: lane.existingPrs, description: null, outputTokens: {},
      reviewMode: 'per-pr', reviewModeWhy: 'existing pull requests (--pr)',
      implemented: null, notImplemented: [], noPr: [], prs,
      reviewCompleted: prs.every((p) => p.reviewCompleted),
    }
  }
  const name = lane.issues.length ? lane.issues.join('+') : 'task'
  const route = routeImplement(lane.hint)
  const impl = implementEffort(route)
  log(`Implement ${subjectOf(lane)} on ${modelName(route.model)} at ${impl.effort} effort (${route.why}).`)

  const implementOpts = (label) => ({
    label,
    phase: 'Implement',
    agentType: 'delivery:code-issue',
    schema: IMPLEMENT_SCHEMA,
    ...modelOpt(route.model),
    ...effortOpt(impl.effort),
    ...iso,
  })
  const alreadyOpen = (issues) => {
    const open = (lane.openPrs || []).filter((o) => issues.includes(o.issue))
    return open.length
      ? `\n\nTriage found a pull request already open for ${open.map((o) => `#${o.issue} (PR #${o.pr})`).join(', ')}. ` +
        `Read it first: continue on its branch if it is this work, and open no second PR for the same issue.`
      : ''
  }
  let built, implementTokens
  if (PER_ISSUE && lane.issues.length > 1) {
    // --per-issue: each issue starts in a fresh context, told where the earlier ones landed.
    const done = []
    let answered = 0
    implementTokens = 0
    for (const n of lane.issues) {
      const earlier = done.filter((i) => i.headRefName && i.pr)
      const [got, tokens] = await metered(() => agent(
        implementPrompt({ ...lane, issues: [n] }, rules) + alreadyOpen([n]) +
          (earlier.length
            ? `\n\nEarlier issues of this batch are not merged yet: ` +
              earlier.map((i) => `#${i.issue} is PR #${i.pr} on branch \`${i.headRefName}\``).join('; ') +
              `. If this issue genuinely depends on one, branch from that branch instead of the ` +
              `default branch and say so in the PR body.`
            : ''),
        implementOpts(`implement:${n}`),
      ))
      implementTokens = implementTokens == null || tokens == null ? null : implementTokens + tokens
      if (got && Array.isArray(got.issues)) { answered++; done.push(...got.issues) }
      else log(`#${n}: its implementer did not return.`)
    }
    built = answered ? { issues: done } : null
  } else {
    ;[built, implementTokens] = await metered(() => agent(implementPrompt(lane, rules) + alreadyOpen(lane.issues), implementOpts(`implement:${name}`)))
  }
  const laneResult = {
    issues: lane.issues,
    description: lane.description || null,
    implementModel: modelName(route.model),
    implementEffort: effortName(impl.effort),
    implementEffortWhy: impl.why,
    implementers: PER_ISSUE && lane.issues.length > 1 ? 'per-issue' : 'per-batch',
    outputTokens: { implement: implementTokens },
  }

  if (!built) {
    log(`Implementation of ${subjectOf(lane)} did not return — nothing to review.`)
    return { ...laneResult, implemented: null, prs: [], reviewCompleted: false }
  }

  // Every issue the caller asked for must come back with a PR, or be named here
  // as not reviewed. Silence about one issue in a batch is not an option.
  const reported = new Set(built.issues.map((i) => i.issue))
  const missing = lane.issues.filter((n) => !reported.has(n))
  const unopened = built.issues.filter((i) => !i.pr)
  for (const n of missing) log(`#${n}: the implementer did not report it — NOT implemented, NOT reviewed.`)
  for (const i of unopened) log(`#${i.issue ?? '?'}: no PR was opened — nothing to review. ${i.report}`)

  const prs = []
  // Two issues reported against ONE pull request get one review, not two of the same diff.
  const firstFor = new Map()
  const repeats = []
  for (const i of built.issues.filter((x) => x.pr)) {
    if (firstFor.has(i.pr)) { repeats.push(i); log(`#${i.issue ?? '?'}: shares PR #${i.pr} with #${firstFor.get(i.pr).issue ?? '?'} — reviewed once, with that issue.`) }
    else firstFor.set(i.pr, i)
  }
  const withPr = [...firstFor.values()]

  // --e2e: before the review, so the specs are part of what is reviewed. Only for a PR whose
  // issue carries a UI label, and it never blocks the lane: no specs is a reported outcome.
  const e2eByPr = new Map()
  if (E2E) {
    for (const it of withPr) {
      const ui = Array.isArray(it.labels) ? it.labels.filter((l) => UI_LABEL.test(l)) : []
      if (!ui.length) { log(`#${it.issue ?? `pr${it.pr}`}: no UI label — no e2e pass (--e2e).`); continue }
      log(`#${it.issue ?? `pr${it.pr}`}: UI label ${ui.join(', ')} — e2e specs before review (--e2e).`)
      const [got, tokens] = await metered(() => agent(e2ePrompt(it, isolated), {
        label: `e2e:${it.issue ?? `pr${it.pr}`}`,
        phase: 'E2E tests',
        agentType: 'delivery:e2e-test',
        schema: E2E_SCHEMA,
        ...modelOpt(route.model),
        ...effortOpt(impl.effort),
        ...iso,
      }))
      e2eByPr.set(it.pr, { result: got ?? null, outputTokens: tokens })
      // New specs changed the diff after the implementer measured it: route the review on an
      // unknown size, which means the full review.
      if (!got || got.added) { it.filesChanged = null; it.linesChanged = null }
    }
  }
  const mode = reviewModeOf(withPr)
  if (BATCH_REVIEW) log(`${subjectOf(lane)}: ${mode.batch ? 'one batch review' : 'one review per PR'} (${mode.why}).`)
  let batchByPr = null
  if (mode.batch) {
    const [got, tokens] = await metered(() => agent(batchReviewPrompt(withPr, rules), {
      label: `review:batch:${name}`,
      phase: 'Review',
      agentType: 'delivery:code-review',
      schema: BATCH_REVIEW_SCHEMA,
      ...modelOpt(BATCH_ROUTE.model),
      ...effortOpt(REVIEW_EFFORT),
      ...iso,
    }))
    laneResult.outputTokens.batchReview = tokens
    batchByPr = new Map((Array.isArray(got?.reviews) ? got.reviews : []).filter((r) => r && Array.isArray(r.findings)).map((r) => [r.pr, r]))
  }
  // One PR at a time within a batch: in the caller's checkout two reviewers would
  // fight over the branch, and the batch is meant to be one lane of work. After a batch
  // review, a PR it returned no entry for counts as not reviewed (reviewOne says so).
  for (const it of withPr) {
    const one = await reviewOne(it, lane, route.model, impl.effort, iso, rules, batchByPr ? { review: batchByPr.get(it.pr) ?? null } : null)
    prs.push(e2eByPr.has(it.pr) ? { ...one, e2e: e2eByPr.get(it.pr) } : one)
  }
  for (const i of repeats) {
    const first = prs.find((p) => p.pr === i.pr)
    // The same review, recorded against the second issue with no tokens of its own.
    if (first) prs.push({ ...first, issue: i.issue, implemented: i.report, sameReviewAs: first.issue, outputTokens: {} })
  }

  return {
    ...laneResult,
    reviewMode: mode.batch ? 'batch' : 'per-pr',
    reviewModeWhy: mode.why,
    implemented: built.issues,
    notImplemented: missing,
    noPr: unopened.map((i) => i.issue),
    prs,
    reviewCompleted: missing.length === 0 && unopened.length === 0 && prs.every((p) => p.reviewCompleted),
  }
}

const batches = parallelLanes
  ? await parallel(lanes.map((lane) => () => runLane(lane, true)))
  : lanes.length ? [await runLane(lanes[0], false)] : []

// parallel() turns a batch that threw into null; report it rather than drop it.
const results = batches.map((b, i) => b || { issues: lanes[i].issues, prs: [], reviewCompleted: false, note: 'This batch failed before it finished.' })

// The compound step. Each review and re-review may return a durableFinding: a lesson a future
// reviewer could not derive from the code. Collected across every PR in the run, deduplicated
// on whitespace- and case-insensitive text, and returned as a SUGGESTION only. Nothing here or
// in any prompt writes it to CLAUDE.md, AGENTS.md or .claude/delivery.md: those are the
// project's authority, and only the maintainer edits them. No durable finding means [].
const suggestedProjectNotes = (() => {
  const seen = new Set()
  const notes = []
  for (const b of results) {
    for (const p of Array.isArray(b?.prs) ? b.prs : []) {
      for (const r of [p?.review, p?.reReview]) {
        // Reviewer output shaped by the PR under review: cap each note's length.
        const text = typeof r?.durableFinding === 'string' ? r.durableFinding.trim().replace(/\s+/g, ' ').slice(0, 500) : ''
        const key = text.toLowerCase()
        if (!text || seen.has(key)) continue
        seen.add(key)
        notes.push(text)
      }
    }
  }
  return notes
})()

return {
  batches: results,
  cheapMode: BATCH_REVIEW,
  triage,
  // PRs whose only blockers are a person's or time's to clear: no fix pass ran for them.
  awaitingOwner: results.flatMap((b) => (Array.isArray(b?.prs) ? b.prs : []).filter((p) => p?.awaiting?.length && !p.fix).map((p) => p.pr)),
  reviewCompleted: results.length > 0 && results.every((b) => b.reviewCompleted),
  merged: false,
  suggestedProjectNotes,
  note:
    'Nothing was merged. Two review cycles per PR is the cap; if a re-review still reports ' +
    'blocking findings, that is for the caller to resolve rather than a third ' +
    'automated pass. A PR listed in awaitingOwner is blocked only on a person or on time, so no fix ran for it. suggestedProjectNotes are suggestions for the project\'s notes file or ' +
    'CLAUDE.md; nothing was written to either.',
}
