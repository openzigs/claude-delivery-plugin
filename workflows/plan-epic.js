export const meta = {
  name: 'plan-epic',
  description: 'Research a topic, then file a GitHub epic and its sub-issues',
  whenToUse:
    'Type /delivery:plan-epic <topic, path or URL> to go from "we should do something about X" to a filed epic with sub-issues, without implementing anything. The counterpart to /delivery:orchestrate, which takes an existing issue and ends at a pull request. This one ends at issues and writes no code.',
  phases: [
    { title: 'Preflight', detail: "read the project's own rules so every later prompt carries them" },
    { title: 'Research', detail: 'delivery:research, via the research-gather skill' },
    { title: 'Plan', detail: 'delivery:code-planner, via the epic-planner skill' },
  ],
}

// Named `plan-epic` rather than `plan` deliberately. Claude Code has a plan mode
// of its own, and a slash command that collides with a built-in is the kind of
// thing that fails by doing nothing -- the exact failure class this pair of
// workflows exists to remove. The longer name also says what it actually
// produces: an epic and its sub-issues, not a plan in the abstract.

const PREAMBLE = `
Ground rules for this dispatch, in priority order:

1. Read the repository's CLAUDE.md (or AGENTS.md) FIRST and obey it exactly. That
   file, not this prompt, is the authority on architecture, build/test commands,
   label and milestone conventions, protected paths and data-handling rules. Where
   it disagrees with anything below, it wins.
2. If .claude/delivery.md exists, read it too. Its absence is normal and is not a
   problem.
3. If neither file exists, infer what you can from the repository itself and SAY IN
   YOUR REPORT what you inferred. A wrong technical claim in an epic is copied into
   every one of its sub-issues before anyone checks it.
4. Use the gh CLI for all GitHub work; it authenticates independently of any MCP
   server. Write every issue body to a file and pass --body-file -- a Mermaid diagram
   inlined into gh issue create --body "..." will be mangled by the shell.
5. This workflow writes NO code and opens NO pull request. It ends at filed issues.
`.trim()

const topic = (args && String(args).trim()) || ''
if (!topic) {
  log(
    'No topic given. Usage: /delivery:plan-epic <what to plan>  — a description, a ' +
      'local directory of documents, or a URL.',
  )
}
const subject = topic || 'the work the caller described in conversation'

phase('Preflight')
const projectRules = await agent(
  `Report this repository's planning constraints so the agents that follow can carry ` +
    `them. Do NOT invoke any skill, do not plan, and do not change anything.\n\n` +
    `1. Identify the repository: \`gh repo view --json nameWithOwner -q .nameWithOwner\`.\n` +
    `2. Read CLAUDE.md if it exists, else AGENTS.md. Quote VERBATIM every hard rule it ` +
    `states that a planner or researcher would need — architecture, component layout, ` +
    `migration policy, protected paths, data-handling rules, label and milestone ` +
    `conventions, where the architecture and user documentation live.\n` +
    `3. Read .claude/delivery.md if it exists and quote it verbatim in full. If it does ` +
    `not exist, say "no .claude/delivery.md" and move on.\n` +
    `4. List the labels that already exist (\`gh label list\`) so the planner does not ` +
    `invent parallel ones.\n` +
    `5. If neither rules file exists, describe the repository layout and toolchains ` +
    `from what is actually there, and label all of it INFERRED.\n\n` +
    `Return a single block headed "PROJECT CONSTRAINTS" that a subagent could follow ` +
    `with no other context.`,
  { label: 'preflight', phase: 'Preflight', effort: 'low' },
)

const CONSTRAINTS = `${PREAMBLE}\n\n--- The project's own rules, gathered from the repository ---\n\n${projectRules}`

phase('Research')
const research = await agent(
  `Gather research material for: ${subject}\n\n` +
    `Invoke the \`/delivery:research-gather\` skill for the full procedure — it ` +
    `resolves because Skill is in your tools. It covers local files (DOCX/PDF/XLSX/PPTX), ` +
    `web pages, and library documentation.\n\n` +
    `Scale the effort to what is actually available. If the caller gave a path or a ` +
    `URL, that is the primary source. If they gave only a topic, do proportionate web ` +
    `and library research rather than an exhaustive sweep — this feeds a planning step, ` +
    `not a dissertation.\n\n` +
    `Ground it in THIS repository too: read the relevant code and the project's ` +
    `architecture and user documentation, and check the existing open issues with ` +
    `\`gh issue list\` so the plan that follows does not duplicate work already filed. ` +
    `Note any issue that already covers part of this.\n\n` +
    `Version every format and API claim, and never assert a dependency, version or API ` +
    `shape you did not read. An open question costs one round-trip; a confident wrong ` +
    `answer costs a correction sweep across every sub-issue.\n\n` +
    `${CONSTRAINTS}\n\n` +
    `Return a structured research summary: what exists today, what is missing, which ` +
    `existing issues overlap, and the constraints a plan must respect.`,
  { label: 'research', phase: 'Research', agentType: 'delivery:research' },
)

phase('Plan')
const planned = await agent(
  `Create a GitHub epic and its sub-issues for: ${subject}\n\n` +
    `Invoke the \`/delivery:epic-planner\` skill for the full procedure — it resolves ` +
    `because Skill is in your tools. It produces Mermaid diagrams, acceptance criteria, ` +
    `story points and a phased order of operations.\n\n` +
    `The research agent gathered the following. Use it as the primary requirements ` +
    `source rather than re-deriving it:\n\n${research}\n\n` +
    `${CONSTRAINTS}\n\n` +
    `How to write this plan:\n` +
    `- **Do not duplicate an existing issue.** The research summary above names ` +
    `overlaps; check them yourself with \`gh issue list\` before filing. A duplicate ` +
    `epic is expensive to unpick once sub-issues hang off it.\n` +
    `- Acceptance criteria should be checkable, not aspirational. Favour criteria that ` +
    `name the failure being prevented — "a test proves a 90-day sweep leaves ` +
    `three-year-old evidence untouched" rather than "retention works".\n` +
    `- Where a defect class is involved, say so. The dominant one is a write reporting ` +
    `success that a read cannot see, from four distinct causes: wrong storage, wrong ` +
    `layer, wrong time, wrong harness.\n` +
    `- Say explicitly which component or toolchain each sub-issue lands in. A sub-issue ` +
    `that straddles two is usually two sub-issues, and splitting it now is far cheaper ` +
    `than splitting it mid-implementation.\n` +
    `- If the work would be better as one issue than an epic, say so and file one. An ` +
    `epic with a single sub-issue is overhead.\n\n` +
    `File them, then report every number you created with its title, and say plainly ` +
    `what you deliberately did NOT file and why.`,
  { label: 'plan', phase: 'Plan', agentType: 'delivery:code-planner' },
)

return {
  topic: topic || null,
  projectRules,
  research,
  plan: planned,
  implemented: false,
  note:
    'Nothing was implemented and no pull request was opened. To take one of the filed ' +
    'issues forward, use /delivery:orchestrate <issue number>.',
}
