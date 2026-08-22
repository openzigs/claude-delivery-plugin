export const meta = {
  name: 'orchestrate',
  description: 'Run a GitHub issue through implement -> review -> fix -> re-review',
  whenToUse:
    'Type /delivery:orchestrate <issue number> to take an issue end to end without naming agents. Unlike dispatching an implementer by hand, the review phase cannot be skipped: it is a step in this script rather than something a model has to remember. Works in any repository — the constraints come from the project\'s own CLAUDE.md, not from this file. Stops before merging.',
  phases: [
    { title: 'Preflight', detail: "read the project's own rules so every later prompt carries them" },
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

// This plugin is project-agnostic, so it hardcodes no project's rules. Instead
// the Preflight phase reads them out of the repository and every later prompt
// carries the result verbatim. A subagent starts with none of the caller's
// context, so naming the file is not enough -- the text has to travel.
const PREAMBLE = `
Ground rules for this dispatch, in priority order:

1. Read the repository's CLAUDE.md (or AGENTS.md) FIRST and obey it exactly. That
   file, not this prompt, is the authority on build/test/lint commands, coverage
   floors, changelog convention, branch and remote conventions, protected paths and
   data-handling rules. Where it disagrees with anything below, it wins.
2. If .claude/delivery.md exists, read it too. It holds delivery-pipeline
   constraints the project wants every dispatched agent to carry. Its absence is
   normal and is not a problem.
3. If neither file exists, infer the gates from the repository itself -- package
   manifests, Makefile, and above all the CI workflow, which is the authoritative
   statement of what must pass -- and SAY IN YOUR REPORT what you inferred. An
   inferred command reported as a known one is how a "green" claim gets made about a
   suite that never ran.
4. Ground every progress claim in a tool result. If a gate failed, say so with the
   output. If you skipped a step, say that. Never report a gate as passed without
   having run it.
5. Lint and format only the files you changed. In a tree with pre-existing findings a
   whole-repo run can never go green and says nothing about your change, and a
   drive-by reformat buries the real diff.
6. Write long issue and PR bodies to a file and pass --body-file. Inlining prose into
   a gh command is how quoting bugs and truncation happen.
7. Do not merge. Merging is the caller's decision.
`.trim()

const LESSONS = `
Two lessons that repeatedly cost real time, in every codebase:

1. A test that cannot fail is not a test. Verify each meaningful test by mutating the
   implementation and watching it go red, and list the mutations you made. Tests
   written after the fix, against the fixed code, routinely pass against the unfixed
   code too and nobody notices -- including repeated vacuous attempts at the SAME
   test by an author who knew the trap.
2. Building an endpoint's first consumer is when its defects surface. The dominant
   defect shape is a write that reports success while the read cannot see it, from
   four distinct causes: wrong storage, wrong layer, wrong time, wrong harness.
   Expect to find one; fix it or file it. If you genuinely find nothing, say you
   looked and where.
`.trim()

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

phase('Preflight')
const projectRules = await agent(
  `Report this repository's delivery constraints so the agents that follow can carry ` +
    `them. Do NOT invoke any skill, do not plan, and do not change anything.\n\n` +
    `1. Identify the repository: \`gh repo view --json nameWithOwner -q .nameWithOwner\` ` +
    `and the default branch.\n` +
    `2. Read CLAUDE.md if it exists, else AGENTS.md. Quote VERBATIM every hard rule it ` +
    `states — exact build/test/lint/typecheck commands, coverage floors, changelog ` +
    `convention, branch naming, remote naming, protected paths, data-handling rules. ` +
    `Do not paraphrase a command; a paraphrased command is a wrong command.\n` +
    `3. Read .claude/delivery.md if it exists and quote it verbatim in full. If it does ` +
    `not exist, say "no .claude/delivery.md" and move on — its absence is normal.\n` +
    `4. If neither file exists, derive the gate from .github/workflows/ and the package ` +
    `manifests, and label every derived command clearly as INFERRED.\n\n` +
    `Return a single block headed "PROJECT CONSTRAINTS" that a subagent could follow ` +
    `with no other context. Be complete but do not invent rules the project has not ` +
    `stated.`,
  { label: 'preflight', phase: 'Preflight', effort: 'low' },
)

const CONSTRAINTS = `${PREAMBLE}\n\n--- The project's own rules, gathered from the repository ---\n\n${projectRules}`

phase('Implement')
const built = await agent(
  `Implement ${subject} end to end in this repository, following the ` +
    `\`/delivery:code-issue\` skill.\n\n` +
    `${CONSTRAINTS}\n\n${LESSONS}\n\n` +
    `${closes} Watch CI to green. Do NOT merge.\n\n` +
    `Report the PR number, what you built, coverage before/after, the mutations you ` +
    `used to prove your tests can fail, any defects you found along the way, and ` +
    `anything you deliberately deferred.`,
  {
    label: `implement:${issueNumber || 'task'}`,
    phase: 'Implement',
    agentType: 'delivery:code-issue',
  },
)

phase('Review')
const reviewed = await agent(
  `Review the pull request that was just opened for ${subject}. Find its number with ` +
    `\`gh pr list --state open\` if the summary below does not name it plainly.\n\n` +
    `What the implementer reported:\n${built}\n\n` +
    `Follow the \`/delivery:code-review\` skill.\n\n${CONSTRAINTS}\n\n` +
    `PUBLISHING: put \`event\` and \`body\` INSIDE the JSON passed to --input, never as ` +
    `-f flags (they go to the query string and a real body 414s). Write the payload to ` +
    `an absolute PR-unique path and jq it back before POSTing — a stale reused ` +
    `findings.json publishes a previous PR's comments and surfaces as repeated 422 ` +
    `"Path could not be resolved". Publish "event": "COMMENT" and open the body with a ` +
    `Recommendation: line. Do NOT write APPROVE, REQUEST_CHANGES or "Verdict:" — where ` +
    `the authenticated gh user is also the PR author, which is usual for an automated ` +
    `pipeline, no review you publish is an independent approval and dressing one up as ` +
    `such defeats a control rather than satisfying it.\n\n` +
    `Verify claims rather than accepting them. Where the author says a test fails ` +
    `without the fix, revert only the production change and watch it — that claim has ` +
    `been wrong before.\n\n` +
    `Return: your recommendation, every finding with severity and file:line, and a ` +
    `clear statement of which findings are BLOCKING.`,
  {
    label: `review:${issueNumber || 'pr'}`,
    phase: 'Review',
    agentType: 'delivery:code-review',
  },
)

// Deliberately a model judgement rather than a regex on the review text:
// reviewers phrase blockers several ways, and a missed match would silently skip
// the fix phase -- the failure this whole workflow exists to prevent.
phase('Fix')
const triage = await agent(
  `Read this code review and answer one question.\n\n${reviewed}\n\n` +
    `Does it contain at least one finding the reviewer considers BLOCKING — something ` +
    `that should be fixed before merge? Ignore non-blocking findings, nits and ` +
    `follow-ups. Answer with exactly one word on the first line, BLOCKING or CLEAR, ` +
    `then one sentence of justification.`,
  { label: 'triage', phase: 'Fix', effort: 'low' },
)

const blocking = /^\s*BLOCKING/i.test(String(triage || ''))
let fixed = null
let rereviewed = null

if (blocking) {
  log('Review returned blocking findings — dispatching the fix.')
  fixed = await agent(
    `Fix the blocking findings from this code review of the open PR for ${subject}.\n\n` +
      `${reviewed}\n\n${CONSTRAINTS}\n\n${LESSONS}\n\n` +
      `Address every BLOCKING finding. For non-blocking ones, either take them or say ` +
      `why not — do not silently ignore them. Re-run the gates and push. Do NOT ` +
      `merge.\n\nReport what you changed and what you declined, with reasons.`,
    { label: 'fix', phase: 'Fix', agentType: 'delivery:code-issue' },
  )

  phase('Re-review')
  rereviewed = await agent(
    `Re-review the PR for ${subject}. This is cycle 2 of a maximum 2 — be decisive and ` +
      `do not open new lines of inquiry that do not affect merge.\n\n` +
      `The original review:\n${reviewed}\n\nWhat the author then did:\n${fixed}\n\n` +
      `${CONSTRAINTS}\n\nSame publishing rules as before: COMMENT event, ` +
      `Recommendation: line, no APPROVE/REQUEST_CHANGES/Verdict wording.\n\n` +
      `Verify each blocking finding was ACTUALLY fixed, by running it rather than by ` +
      `reading the response. Then answer: is anything still blocking?`,
    { label: 'rereview', phase: 'Re-review', agentType: 'delivery:code-review' },
  )
} else {
  log('Review returned no blocking findings — skipping fix and re-review.')
}

return {
  issue: issueNumber,
  subject,
  projectRules,
  implemented: built,
  review: reviewed,
  blockingFindings: blocking,
  fix: fixed,
  reReview: rereviewed,
  merged: false,
  note:
    'Nothing was merged. Two review cycles is the cap; if the re-review still reports ' +
    'blocking findings, that is for the caller to resolve rather than a third ' +
    'automated pass.',
}
