export const meta = {
  name: 'orchestrate',
  description: 'Run GitHub issues through implement -> review -> fix -> re-review, one PR each',
  whenToUse:
    'Type /delivery:orchestrate <issue number> to take an issue end to end without naming agents; /delivery:orchestrate 412 413 415 to have one implementer work related issues in turn (one PR each, each reviewed); /delivery:orchestrate 412 413 ; 500 501 to run independent batches concurrently in separate git worktrees. Optional size hint: --points N or --small. Unlike dispatching an implementer by hand, the review phase cannot be skipped: it is a step in this script rather than something a model has to remember. Works in any repository — the constraints come from the project\'s own CLAUDE.md, not from this file. Stops before merging.',
  phases: [
    { title: 'Implement', detail: 'delivery:code-issue takes each issue in the batch to a green PR' },
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

1. The repository's CLAUDE.md is already in your context; do not re-read it. It is the
   authority on commands, coverage floors, changelog, branch and remote conventions,
   protected paths and data handling, and it wins over anything in this prompt. If the
   repository has an AGENTS.md and no CLAUDE.md, read AGENTS.md instead. If it has neither,
   infer the commands and conventions from the repository (manifests, CI workflow) and say
   in your report what you inferred.
2. Orient in one batched Bash call, as your procedure's first step describes, and include
   \`cat .claude/delivery.md 2>/dev/null\` in it rather than reading that file separately: it
   holds delivery constraints this project wants every dispatched agent to carry. Its absence
   is normal. Then read every file you need in one response of parallel reads.
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
        },
        required: ['severity', 'location', 'summary', 'blocking'],
      },
    },
    verification: {
      type: 'string',
      description: 'What you ran to verify the author\'s claims, and what you could not check',
    },
    durableFinding: {
      type: 'string',
      description: 'Optional: a lesson a future reviewer could not derive from the code',
    },
  },
  required: ['recommendation', 'blocking', 'findings', 'verification'],
}

const formatReview = (r) =>
  [
    `PR: ${r.pr ?? 'unknown'}`,
    r.recommendation,
    ...r.findings.map(
      (f) => `- [${f.blocking ? 'BLOCKING' : 'non-blocking'}] ${f.severity} ${f.location}: ${f.summary}`,
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

// Model tiering lives here, in the script, and NOT in agent frontmatter. Every
// agent stays `model: inherit`: a frontmatter pin applies however the agent is
// reached and is invisible to the caller (a pinned research agent once dropped
// an opus-driven run to sonnet for its whole phase). A choice made here applies
// only to this pipeline, is decided by code, and is logged on every run.
//
// INHERIT means "omit `model`", i.e. run on whatever the session runs on. Aliases
// rather than model IDs, so the plugin tracks new releases without an edit.
const INHERIT = null
const SONNET = 'sonnet'
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
const routeImplement = (hint) => {
  if (hint.small) return { model: SONNET, why: 'caller hint --small' }
  if (hint.points == null) return { model: INHERIT, why: 'no size hint' }
  if (hint.points <= SMALL_POINTS) return { model: SONNET, why: `caller hint ${hint.points} story points` }
  return { model: INHERIT, why: `caller hint ${hint.points} story points` }
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
    model: SONNET,
    why: `${it.storyPoints} story points, no risk label, ${it.filesChanged} files / ${it.linesChanged} lines`,
  }
}

// After a review, the work is narrow -- the findings spell out the fix -- so the
// fix drops to sonnet, unless sonnet did the implementing and still produced
// blocking findings: that is evidence the task was harder than it looked, so the
// fix escalates to the session model rather than asking sonnet to try again.
const fixModel = (implementedOn) => (implementedOn === SONNET ? INHERIT : SONNET)
// The re-review only confirms that listed findings are gone, so it runs on
// sonnet -- unless the first review was the light one. A small change that a
// light review still blocked was misjudged as low-risk, and cycle 2 is its first
// full-scope look, so that re-review escalates to the session model.
const rereviewModel = (route) => (route.light ? INHERIT : SONNET)
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

const segments = raw.split(';').map((s) => s.trim()).filter(Boolean).map(parseSegment)
let lanes
if (segments.length && segments.every((s) => s.issues)) {
  // An issue listed twice would get two implementers racing for one branch.
  const seen = new Set()
  lanes = segments
    .map((s) => ({
      hint: s.hint,
      issues: s.issues.filter((n) => (seen.has(n) ? (log(`#${n} is listed more than once; working it once.`), false) : seen.add(n))),
    }))
    .filter((l) => l.issues.length)
} else {
  // A description may itself contain ';' -- only all-numeric segments are batches.
  const whole = parseSegment(raw)
  lanes = [{ hint: whole.hint, issues: [], description: whole.description }]
}

if (!raw) {
  log(
    'No target given. Usage: /delivery:orchestrate <issue number> [more issue numbers] ' +
      '[; another batch] [--points N | --small]  or  /delivery:orchestrate <what you want done>',
  )
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

async function reviewOne(it, lane, implementModel, iso, rules) {
  const tag = it.issue ?? `pr${it.pr}`
  const subject = it.issue ? `issue #${it.issue}` : subjectOf(lane)
  const route = routeReview(it)
  const models = { implement: implementModel, review: route.model }
  const effort = { implement: IMPLEMENT_EFFORT, review: REVIEW_EFFORT }
  const outputTokens = { review: null }
  log(
    `#${tag}: ${route.light ? 'light review' : 'full review'} on ${modelName(route.model)} ` +
      `(${route.why}).`,
  )
  const [reviewed, reviewTokens] = await metered(() => agent(
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
  outputTokens.review = reviewTokens
  const effortNames = () => Object.fromEntries(Object.entries(effort).map(([k, e]) => [k, effortName(e)]))
  const base = {
    issue: it.issue,
    pr: it.pr,
    implemented: it.report,
    reviewScope: route.light ? 'light' : 'full',
    reviewRouting: route.why,
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
  let fixed = null
  let rereviewed = null

  if (blocking) {
    models.fix = fixModel(implementModel)
    models.rereview = rereviewModel(route)
    effort.fix = FIX_EFFORT
    effort.rereview = rereviewEffort(route)
    log(
      `#${tag}: blocking findings — fix on ${modelName(models.fix)}` +
        (models.fix === INHERIT && implementModel === SONNET
          ? ' (escalated: the sonnet implementation did not pass review)'
          : '') +
        `, re-review on ${modelName(models.rereview)}` +
        (route.light ? ' (escalated: a light review found blocking findings, so cycle 2 is full scope).' : '.'),
    )
    // The fix pushes to the PR that exists. Its branch comes from the implementer's gh
    // read; if that was not reported, the agent is told to read it, never to guess one.
    const head = it.headRefName
      ? `The PR's head branch is \`${it.headRefName}\`.`
      : `Read the PR's head branch with \`gh pr view ${it.pr} --json headRefName\` before you start.`
    ;[fixed, outputTokens.fix] = await metered(() => agent(
      `Fix the blocking findings from this code review of PR #${it.pr} for ${subject}, ` +
        `following the Fix mode section of the code-issue procedure (preloaded). ` +
        `${head} Push your fixes to that existing branch. Do not create a new branch or a ` +
        `new PR, and skip the steps Fix mode skips.\n\n` +
        `${reviewText}\n\n${rules}\n\n` +
        `Address every BLOCKING finding, and prove each fix with a test you have seen fail ` +
        `without it. For non-blocking ones, either take them or say why not — do not ` +
        `silently ignore them. Re-run the gates and push.\n\n` +
        `Return, as structured output, each finding you changed (with its test), each you ` +
        `declined (with the reason), and whether the gates passed and the fixes are pushed.`,
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

    ;[rereviewed, outputTokens.rereview] = await metered(() => agent(
      `Re-review PR #${it.pr} for ${subject}, following the code-review procedure (preloaded). ` +
        `This is cycle 2 of a maximum 2 — be decisive and do not open new lines of inquiry ` +
        `that do not affect merge.` +
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
    models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, modelName(m)])),
    effort: effortNames(),
    outputTokens,
    findingCounts: { review: countBySeverity(reviewed), rereview: countBySeverity(rereviewed) },
  }
}

async function runLane(lane, isolated) {
  // Isolation is all or nothing per batch: concurrent batches sharing one checkout
  // would switch branches under each other, so every agent in a concurrent batch
  // gets its own worktree. A single batch runs in the caller's checkout as before.
  const iso = isolated ? { isolation: 'worktree' } : {}
  const rules = isolated ? `${RULES}\n\n${ISOLATED}` : RULES
  const name = lane.issues.length ? lane.issues.join('+') : 'task'
  const route = routeImplement(lane.hint)
  log(`Implement ${subjectOf(lane)} on ${modelName(route.model)} (${route.why}).`)

  const [built, implementTokens] = await metered(() => agent(implementPrompt(lane, rules), {
    label: `implement:${name}`,
    phase: 'Implement',
    agentType: 'delivery:code-issue',
    schema: IMPLEMENT_SCHEMA,
    ...modelOpt(route.model),
    ...effortOpt(IMPLEMENT_EFFORT),
    ...iso,
  }))
  const laneResult = {
    issues: lane.issues,
    description: lane.description || null,
    implementModel: modelName(route.model),
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
  // One PR at a time within a batch: in the caller's checkout two reviewers would
  // fight over the branch, and the batch is meant to be one lane of work.
  for (const it of built.issues.filter((i) => i.pr)) prs.push(await reviewOne(it, lane, route.model, iso, rules))

  return {
    ...laneResult,
    implemented: built.issues,
    notImplemented: missing,
    noPr: unopened.map((i) => i.issue),
    prs,
    reviewCompleted: missing.length === 0 && unopened.length === 0 && prs.every((p) => p.reviewCompleted),
  }
}

const batches = parallelLanes
  ? await parallel(lanes.map((lane) => () => runLane(lane, true)))
  : [await runLane(lanes[0], false)]

// parallel() turns a batch that threw into null; report it rather than drop it.
const results = batches.map((b, i) => b || { issues: lanes[i].issues, prs: [], reviewCompleted: false, note: 'This batch failed before it finished.' })

return {
  batches: results,
  reviewCompleted: results.every((b) => b.reviewCompleted),
  merged: false,
  note:
    'Nothing was merged. Two review cycles per PR is the cap; if a re-review still reports ' +
    'blocking findings, that is for the caller to resolve rather than a third ' +
    'automated pass.',
}
