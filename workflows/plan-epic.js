export const meta = {
  name: 'plan-epic',
  description: 'Research a topic, then file a GitHub epic and its sub-issues',
  whenToUse:
    'Type /delivery:plan-epic <topic, path or URL> to go from "we should do something about X" to a filed epic with sub-issues, without implementing anything. The counterpart to /delivery:orchestrate, which takes an existing issue and ends at a pull request. This one ends at issues and writes no code.',
  phases: [
    { title: 'Research', detail: 'delivery:research, via the research-gather skill' },
    { title: 'Plan', detail: 'delivery:code-planner, via the epic-planner skill' },
  ],
}

// Named `plan-epic` rather than `plan` deliberately. Claude Code has a plan mode
// of its own, and a slash command that collides with a built-in is the kind of
// thing that fails by doing nothing -- the exact failure class this pair of
// workflows exists to remove. The longer name also says what it actually
// produces: an epic and its sub-issues, not a plan in the abstract.

// Every workflow subagent starts with the repository's CLAUDE.md already
// injected, so this script does not quote it (an earlier Preflight phase did,
// paying for the same text two or three times per dispatch). The procedure --
// versioned claims, "could not confirm", checkable criteria, no duplicate
// issues -- lives in the research and planner agents and their skills, and is
// not repeated here.
const RULES = `
Ground rules for this dispatch:

1. The project's rules win over anything in this prompt. Your skill's "Before You Start"
   section says how to treat CLAUDE.md, AGENTS.md and a repository with neither.
2. Orient in one batched Bash call, joined with \`;\` so a missing file does not abort it, and
   include \`cat .claude/delivery.md 2>/dev/null\` in it rather than reading that file
   separately: it holds constraints this project wants every dispatched agent to carry. Its
   absence is normal. Then read every file you need in one response of parallel reads.
3. Where the project states no rule, infer from the repository and say in your report
   what you inferred.
4. This workflow writes NO code and opens NO pull request. It ends at filed issues.
5. **Unattended runs.** When a workflow or another agent dispatched you, no user is present:
   never stop to ask a question or wait for a reply. Where a step says to ask, confirm or offer a
   choice, decide from the request, the issue and the repository, record the decision and why in
   your report, and carry on. Those steps apply only when a user invoked you interactively.
`.trim()

// The planner answers in structure, so the workflow can check the one thing the delivery
// workflow routes on -- every sub-issue's Story Points line -- instead of trusting prose, and can
// name the command that takes the epic forward. A missing field is reported, never guessed.
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    epic: { type: ['integer', 'null'], description: 'The epic you filed (the master epic, if there are several); null if you filed a single issue or none' },
    issues: {
      type: 'array',
      description: 'One entry per issue you filed that is to be implemented (not the epics themselves)',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer' },
          title: { type: 'string' },
          storyPoints: { type: ['integer', 'null'], description: 'The number on the "Story Points" line you wrote in its body; null if you wrote none' },
          labels: { type: 'array', items: { type: 'string' } },
          blockedBy: { type: 'array', items: { type: 'integer' }, description: 'Issue numbers its body says it is blocked by' },
        },
        required: ['number', 'title', 'storyPoints', 'labels', 'blockedBy'],
      },
    },
    notFiled: { type: 'string', description: 'What you deliberately did not file, and why' },
    report: { type: 'string', description: 'Your planning report: the structure, what you inferred, the open questions carried over' },
  },
  required: ['epic', 'issues', 'notFiled', 'report'],
}

const topic = (args && String(args).trim()) || ''
if (!topic) {
  log(
    'No topic given. Usage: /delivery:plan-epic <what to plan>  — a description, a ' +
      'local directory of documents, or a URL.',
  )
}
const subject = topic || 'the work the caller described in conversation'

// Kept in step by hand: this helper is duplicated on purpose in orchestrate.js and plan-epic.js,
// because workflow scripts cannot import each other. Change both copies together.
// Output tokens per phase, as budget.spent() deltas. No effort is set here: both
// stages inherit the session's effort. Null, never a throw, if `budget` is absent.
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

phase('Research')
const [research, researchTokens] = await metered(() => agent(
  `Gather research material for: ${subject}\n\n` +
    `Follow the \`/delivery:research-gather\` skill. If the caller gave a path or a URL, ` +
    `that is the primary source; if only a topic, keep web and library research ` +
    `proportionate — this feeds a planning step, not a dissertation.\n\n` +
    `${RULES}\n\n` +
    `Return a structured research summary: what exists today, what is missing, which ` +
    `existing issues overlap, and the constraints a plan must respect.`,
  { label: 'research', phase: 'Research', agentType: 'delivery:research' },
))

phase('Plan')
const [planned, planTokens] = await metered(() => agent(
  `Create a GitHub epic and its sub-issues for: ${subject}\n\n` +
    `Follow the \`/delivery:epic-planner\` skill. Run \`gh label list\` before filing so ` +
    `you use the project's existing labels rather than inventing parallel ones.\n\n` +
    `The research agent gathered the following. Use it as the primary requirements ` +
    `source rather than re-deriving it:\n\n${research}\n\n${RULES}\n\n` +
    `File them, then report every number you created with its title, and say plainly ` +
    `what you deliberately did NOT file and why. Every issue to be implemented carries a ` +
    `\`**Story Points**: N\` line and names what blocks it; report both as you wrote them.`,
  { label: 'plan', phase: 'Plan', agentType: 'delivery:code-planner', schema: PLAN_SCHEMA },
))
const filed = Array.isArray(planned?.issues) ? planned.issues.filter((i) => i && Number.isInteger(i.number)) : []
// The delivery workflow sends an issue with no points line to the full review on the session
// model, whatever its size. Over 1,589 real PRs, 56% had none.
const missingStoryPoints = filed.filter((i) => !Number.isInteger(i.storyPoints)).map((i) => i.number)
if (missingStoryPoints.length) {
  log(`Filed without a Story Points line: ${missingStoryPoints.map((n) => `#${n}`).join(', ')}. /delivery:orchestrate cannot size these.`)
}
const epic = Number.isInteger(planned?.epic) ? planned.epic : null

return {
  topic: topic || null,
  research,
  plan: planned,
  epic,
  filedIssues: filed.map((i) => i.number),
  missingStoryPoints,
  implemented: false,
  outputTokens: { research: researchTokens, plan: planTokens },
  next: epic != null && filed.length
    ? `/delivery:orchestrate --epic ${epic}`
    : filed.length ? `/delivery:orchestrate ${filed.map((i) => i.number).join(' ')}` : null,
  note:
    'Nothing was implemented and no pull request was opened. To take one of the filed ' +
    'issues forward, use /delivery:orchestrate <issue number>; --epic <epic number> batches ' +
    'an epic\'s sub-issues by their dependencies.',
}
