export const meta = {
  name: 'orchestrate',
  description: 'Run a GitHub issue through implement -> review -> fix -> re-review',
  whenToUse:
    'Type /delivery:orchestrate <issue number> to take an issue end to end without naming agents. Unlike dispatching an implementer by hand, the review phase cannot be skipped: it is a step in this script rather than something a model has to remember. Works in any repository — the constraints come from the project\'s own CLAUDE.md, not from this file. Stops before merging.',
  phases: [
    { title: 'Implement', detail: 'delivery:code-issue takes the issue to a green PR' },
    { title: 'Review', detail: 'delivery:code-review reads the PR independently' },
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
// mechanics) lives in the skills each agent invokes, and is not repeated here.
const RULES = `
Ground rules for this dispatch:

1. The repository's CLAUDE.md is already in your context; do not re-read it. It is the
   authority on commands, coverage floors, changelog, branch and remote conventions,
   protected paths and data handling, and it wins over anything in this prompt. If the
   repository has an AGENTS.md and no CLAUDE.md, read AGENTS.md instead.
2. If .claude/delivery.md exists, read it: it holds delivery constraints this project
   wants every dispatched agent to carry. Its absence is normal.
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

// Treat the review as blocking if EITHER the top-level flag or any single
// finding says so. Disagreement between the two should err towards a fix pass.
const isBlocking = (r) => Boolean(r.blocking || r.findings.some((f) => f.blocking))

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

// The first review is the quality gate and always inherits: a reviewer weaker
// than the implementer is the pairing most likely to wave a defect through.
// What follows it is narrow -- the findings spell out the fix, and the re-review
// only has to confirm those findings are gone -- so both drop to sonnet. The one
// exception: if sonnet did the implementing and still produced blocking
// findings, that is evidence the task was harder than it looked, so the fix
// escalates to the session model rather than asking sonnet to try again.
const fixModel = (implementedOn) => (implementedOn === SONNET ? INHERIT : SONNET)
const REREVIEW_MODEL = SONNET
// fix and rereview are only set when those phases run.
const models = { implement: INHERIT, review: INHERIT }

const raw = (args && String(args).trim()) || ''

// `/delivery:orchestrate 301` and `/delivery:orchestrate make the audit filter
// honour a date range` must both work. A bare number (optionally #-prefixed) is
// an issue; anything else is a description, and the implementer files the issue
// first so the work still has a record. Interpolating `issue #${raw}`
// unconditionally produces `issue #make the audit filter...`, which reads as a
// real reference and is not one.
const issueNumber = /^#?\d+$/.test(raw) ? raw.replace(/^#/, '') : null
const subject = issueNumber
  ? `issue #${issueNumber}`
  : raw
    ? `this request: ${raw}`
    : 'the work the caller described in conversation'

if (!raw) {
  log(
    'No target given. Usage: /delivery:orchestrate <issue number>  or  ' +
      '/delivery:orchestrate <what you want done>',
  )
}

const closes = issueNumber
  ? `Open a PR with \`Closes #${issueNumber}\`.`
  : 'File a GitHub issue for this first, then open a PR that closes it — ' +
    'work without an issue leaves no record of why it was done.'

phase('Implement')

// Route the implementation on facts already written into the issue, not on a
// model's opinion of how hard it looks. epic-planner puts a Fibonacci
// `**Story Points**: N` line in every sub-issue, and labels mark risky areas. The
// workflow runtime has no network access, so haiku fetches them, at low effort
// and with a schema. It does the reading only; the rules below make the decision.
// Anything the router cannot establish falls back to the session model. An
// unknown size is never a reason to use a cheaper model.
const SIZE_SCHEMA = {
  type: 'object',
  properties: {
    storyPoints: {
      type: ['integer', 'null'],
      description: 'The number on the issue body\'s "Story Points" line, or null if there is none',
    },
    labels: { type: 'array', items: { type: 'string' }, description: 'Every label name on the issue' },
  },
  required: ['storyPoints', 'labels'],
}
const SMALL_POINTS = 2
const RISKY_LABEL = /secur|auth|migrat|breaking|payment|billing|privacy|infra|data-loss/i

const routeImplement = (size) => {
  if (!size) return { model: INHERIT, why: 'issue size unknown' }
  const risky = size.labels.filter((l) => RISKY_LABEL.test(l))
  if (risky.length) return { model: INHERIT, why: `risk label ${risky.join(', ')}` }
  if (size.storyPoints == null) return { model: INHERIT, why: 'no story points on the issue' }
  if (size.storyPoints <= SMALL_POINTS) return { model: SONNET, why: `${size.storyPoints} story points` }
  return { model: INHERIT, why: `${size.storyPoints} story points` }
}

let route = { model: INHERIT, why: 'no issue number to size' }
if (issueNumber) {
  const size = await agent(
    `Do not research, plan or change anything. Run exactly ` +
      `\`gh issue view ${issueNumber} --json labels,body\` and report the issue's labels and ` +
      `the number on its "Story Points" line (null if there is no such line).`,
    {
      label: `size:${issueNumber}`,
      phase: 'Implement',
      agentType: 'delivery:research',
      schema: SIZE_SCHEMA,
      model: 'haiku',
      effort: 'low',
    },
  )
  route = routeImplement(size)
}
models.implement = route.model
log(`Implement on ${modelName(models.implement)} (${route.why}).`)
const built = await agent(
  `Implement ${subject} end to end in this repository, following the ` +
    `\`/delivery:code-issue\` skill.\n\n${RULES}\n\n` +
    `${closes} Watch CI to green.\n\n` +
    `Report the PR number, what you built, coverage before/after, the mutations you ` +
    `used to prove your tests can fail, any defects you found along the way, and ` +
    `anything you deliberately deferred.`,
  {
    label: `implement:${issueNumber || 'task'}`,
    phase: 'Implement',
    agentType: 'delivery:code-issue',
    ...modelOpt(models.implement),
  },
)

phase('Review')
const reviewed = await agent(
  `Review the pull request that was just opened for ${subject}, following the ` +
    `\`/delivery:code-review\` skill. Find its number with \`gh pr list --state open\` ` +
    `if the report below does not name it plainly.\n\n` +
    `What the implementer reported:\n${built}\n\n${RULES}\n\n` +
    `Publish the review to GitHub as the skill describes, then return your ` +
    `recommendation and every finding with severity, file:line and whether it is blocking.`,
  {
    label: `review:${issueNumber || 'pr'}`,
    phase: 'Review',
    agentType: 'delivery:code-review',
    schema: REVIEW_SCHEMA,
  },
)

// A review that never came back is not a clean review. Stop loudly rather than
// fall through to "no blocking findings" -- the failure this workflow exists to
// prevent is a review phase that silently did not happen.
if (!reviewed) {
  log('Review did not complete — stopping. The PR has NOT been reviewed.')
  return {
    issue: issueNumber,
    subject,
    implemented: built,
    review: null,
    reviewCompleted: false,
    merged: false,
    note: 'The review phase did not return. Re-run the review before treating this PR as reviewed.',
  }
}

phase('Fix')
const blocking = isBlocking(reviewed)
const reviewText = formatReview(reviewed)
let fixed = null
let rereviewed = null

if (blocking) {
  models.fix = fixModel(models.implement)
  models.rereview = REREVIEW_MODEL
  log(
    `Review returned blocking findings — dispatching the fix on ${modelName(models.fix)}` +
      (models.fix === INHERIT && models.implement === SONNET
        ? ' (escalated: the sonnet implementation did not pass review).'
        : '.'),
  )
  fixed = await agent(
    `Fix the blocking findings from this code review of the open PR for ${subject}.\n\n` +
      `${reviewText}\n\n${RULES}\n\n` +
      `Address every BLOCKING finding, and prove each fix with a test you have seen fail ` +
      `without it. For non-blocking ones, either take them or say why not — do not ` +
      `silently ignore them. Re-run the gates and push.\n\n` +
      `Report what you changed and what you declined, with reasons.`,
    { label: 'fix', phase: 'Fix', agentType: 'delivery:code-issue', ...modelOpt(models.fix) },
  )

  phase('Re-review')
  log(`Re-review on ${modelName(models.rereview)}.`)
  rereviewed = await agent(
    `Re-review the PR for ${subject}, following the \`/delivery:code-review\` skill. ` +
      `This is cycle 2 of a maximum 2 — be decisive and do not open new lines of inquiry ` +
      `that do not affect merge.\n\n` +
      `The original review:\n${reviewText}\n\nWhat the author then did:\n${fixed}\n\n` +
      `${RULES}\n\n` +
      `Verify each blocking finding was ACTUALLY fixed, by running it rather than by ` +
      `reading the response. Publish as the skill describes, then return what is still ` +
      `blocking, if anything.`,
    {
      label: 'rereview',
      phase: 'Re-review',
      agentType: 'delivery:code-review',
      schema: REVIEW_SCHEMA,
      ...modelOpt(models.rereview),
    },
  )
} else {
  log('Review returned no blocking findings — skipping fix and re-review.')
}

return {
  issue: issueNumber,
  subject,
  implemented: built,
  review: reviewed,
  reviewCompleted: true,
  blockingFindings: blocking,
  fix: fixed,
  reReview: rereviewed,
  stillBlocking: rereviewed ? isBlocking(rereviewed) : null,
  models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, modelName(m)])),
  merged: false,
  note:
    'Nothing was merged. Two review cycles is the cap; if the re-review still reports ' +
    'blocking findings, that is for the caller to resolve rather than a third ' +
    'automated pass.',
}
