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

1. The repository's CLAUDE.md is already in your context; do not re-read it. It is the
   authority on architecture, commands, label and milestone conventions, protected paths
   and data handling, and it wins over anything in this prompt. If the repository has an
   AGENTS.md and no CLAUDE.md, read AGENTS.md instead.
2. Orient in one batched Bash call, joined with \`;\` so a missing file does not abort it, and
   include \`cat .claude/delivery.md 2>/dev/null\` in it rather than reading that file
   separately: it holds constraints this project wants every dispatched agent to carry. Its
   absence is normal. Then read every file you need in one response of parallel reads.
3. Where the project states no rule, infer from the repository and say in your report
   what you inferred.
4. This workflow writes NO code and opens NO pull request. It ends at filed issues.
`.trim()

const topic = (args && String(args).trim()) || ''
if (!topic) {
  log(
    'No topic given. Usage: /delivery:plan-epic <what to plan>  — a description, a ' +
      'local directory of documents, or a URL.',
  )
}
const subject = topic || 'the work the caller described in conversation'

phase('Research')
const research = await agent(
  `Gather research material for: ${subject}\n\n` +
    `Follow the \`/delivery:research-gather\` skill. If the caller gave a path or a URL, ` +
    `that is the primary source; if only a topic, keep web and library research ` +
    `proportionate — this feeds a planning step, not a dissertation.\n\n` +
    `${RULES}\n\n` +
    `Return a structured research summary: what exists today, what is missing, which ` +
    `existing issues overlap, and the constraints a plan must respect.`,
  { label: 'research', phase: 'Research', agentType: 'delivery:research' },
)

phase('Plan')
const planned = await agent(
  `Create a GitHub epic and its sub-issues for: ${subject}\n\n` +
    `Follow the \`/delivery:epic-planner\` skill. Run \`gh label list\` before filing so ` +
    `you use the project's existing labels rather than inventing parallel ones.\n\n` +
    `The research agent gathered the following. Use it as the primary requirements ` +
    `source rather than re-deriving it:\n\n${research}\n\n${RULES}\n\n` +
    `File them, then report every number you created with its title, and say plainly ` +
    `what you deliberately did NOT file and why.`,
  { label: 'plan', phase: 'Plan', agentType: 'delivery:code-planner' },
)

return {
  topic: topic || null,
  research,
  plan: planned,
  implemented: false,
  note:
    'Nothing was implemented and no pull request was opened. To take one of the filed ' +
    'issues forward, use /delivery:orchestrate <issue number>.',
}
