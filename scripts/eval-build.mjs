#!/usr/bin/env node
//
// Generate the review eval suite's prompts, scaffolds and full-scope copies from the workflow.
// Stdlib only.
//
//   node scripts/eval-build.mjs           # write every generated file
//   node scripts/eval-build.mjs --check   # exit 1, naming each file, if any is out of date
//
// Each case under evals/ is hand-written as a case.yaml (its name and tags), a fixture.txt (the
// repository and pull request, see scripts/eval-scaffold.mjs) and its graders. Everything else is
// generated here, so the eval dispatches the review exactly as workflows/orchestrate.js does:
//
//   - the review prompt is RENDERED by running the workflow against a stub agent(), the way
//     scripts/footprint.mjs measures it -- a light route for the light copy, a full route for the
//     full copy, the --batch-review prompt and the per-PR prompts for the batch comparison. The
//     LIGHT scope text, the ground rules and the confidence definition are therefore the
//     workflow's own, never a copy; change them there and --check fails until this is re-run.
//   - each case's prompt.md asks the session to dispatch that prompt to the delivery:code-review
//     agent, whose skills: frontmatter preloads the code-review procedure, and to relay its reply.
//     The agent gets the repository the fixture builds, not a diff in its prompt.
//   - graders/review-agent-dispatched.md proves the agent ran; eval-tiers.mjs marks a run that
//     did not dispatch it invalid.
//   - evals/full/<case>/ is the same case at FULL scope, named <case>-full.
//
// Two harness facts are added around the rendered prompt and nowhere else: a preamble mapping the
// `gh` reads to the files the fixture writes under .pr/ (the eval sandbox reaches no GitHub), and
// the reply format the graders read (the workflow takes the same review as structured output).
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, chmodSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVALS = join(ROOT, 'evals')

// The two batch-comparison cases share one fixture: three PRs, reviewed as one --batch-review
// dispatch in the first and as three per-PR dispatches in the second.
export const BATCH_CASE = 'batch-three-prs'
export const PER_PR_CASE = 'per-pr-three-prs'
export const BATCH_ISSUES = [412, 413, 415]
const prOf = (issue) => 1000 + issue

// ------------------------------------------------------------------ render the workflow
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflowSource = () => readFileSync(join(ROOT, 'workflows', 'orchestrate.js'), 'utf8')
async function renderWorkflow(src, argv, facts) {
  const dispatches = []
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', 'budget',
    src.replace(/export const meta = \{[\s\S]*?\n\}\n/, ''))
  const clean = (pr) => ({ pr, recommendation: 'Recommendation: merge', blocking: false, findings: [], verification: 'stub' })
  await fn(argv, async (prompt, o = {}) => {
    dispatches.push({ prompt, ...o })
    if (o.schema?.properties?.issues) {
      const nums = [...prompt.split('\n')[0].matchAll(/#(\d+)/g)].map((m) => Number(m[1]))
      return { issues: nums.map((n) => ({ issue: n, pr: prOf(n), headRefName: `feature/issue-${n}`, ...facts, report: 'stub' })) }
    }
    if (o.schema?.properties?.reviews) return { reviews: nums(prompt).map(clean) }
    if (o.schema?.properties?.changed) return { changed: [], declined: [], gates: { passed: true, pushed: true } }
    if (o.schema) return clean(null)
    return ''
  }, () => {}, () => {}, (ts) => Promise.all(ts.map((t) => t())), undefined)
  return dispatches
}
const nums = (prompt) => [...prompt.matchAll(/PR #(\d+)/g)].map((m) => Number(m[1])).filter((n, i, a) => a.indexOf(n) === i)

// The facts the workflow routes on: a 1-point, 2-file change with no label goes to the light
// review; a 5-point one to the full review. The batch has no risk label, so --batch-review applies.
const LIGHT_FACTS = { storyPoints: 1, labels: [], filesChanged: 2, linesChanged: 40 }
const FULL_FACTS = { storyPoints: 5, labels: [], filesChanged: 3, linesChanged: 80 }

// `src` is the workflow's source; the verifier passes an edited copy to prove the eval follows it.
export async function renderReviewPrompts(src = workflowSource()) {
  const pick = (ds, label) => {
    const d = ds.find((x) => x.label === label)
    if (!d) throw new Error(`the workflow dispatched no ${label}`)
    return d
  }
  const light = pick(await renderWorkflow(src, '412', LIGHT_FACTS), 'review:412')
  const full = pick(await renderWorkflow(src, '412', FULL_FACTS), 'review:412')
  const perPrRun = await renderWorkflow(src, BATCH_ISSUES.join(' '), FULL_FACTS)
  const perPr = BATCH_ISSUES.map((n) => pick(perPrRun, `review:${n}`))
  const batch = pick(await renderWorkflow(src, `${BATCH_ISSUES.join(' ')} --batch-review`, FULL_FACTS), `review:batch:${BATCH_ISSUES.join('+')}`)
  if (!/Review scope: LIGHT/.test(light.prompt) || /Review scope: LIGHT/.test(full.prompt)) {
    throw new Error('the light route no longer carries the LIGHT scope text, or the full route does')
  }
  const finding = full.schema?.properties?.findings?.items?.properties || {}
  return {
    light: light.prompt,
    full: full.prompt,
    perPr: perPr.map((d) => d.prompt),
    batch: batch.prompt,
    agentType: full.agentType,
    severities: finding.severity?.enum || [],
    confidence: finding.confidence?.description || '',
  }
}

// ------------------------------------------------------------------ the harness text
const context = (prs) => {
  const one = prs.length === 1
  const lines = [
    'Evaluation harness: this checkout stands in for GitHub, which cannot be reached from here. Do not run `gh`, ' +
      'publish nothing, and ask no questions. Where the procedure reads from GitHub, read these files instead:',
    ...prs.flatMap(({ pr, issue }) => [
      `- pull request #${pr} is the branch \`pr/${pr}\`${one ? ', checked out in the current directory' : ''}; its base is \`main\`. ` +
        `\`gh pr diff ${pr}\` is \`.pr/${pr}.diff\` and \`gh pr view ${pr} --json body\` is \`.pr/${pr}-body.md\``,
      `- \`gh issue view ${issue}\` is \`.pr/issue-${issue}.md\``,
    ]),
    '- there are no CI checks to read.',
    one
      ? 'If `git` fails in this sandbox, the working tree is the pull request\'s head and its .diff file is its whole change.'
      : 'The checkout is `main`, the base of every pull request. If `git` fails in this sandbox, each .diff file is that pull request\'s whole change.',
  ]
  return lines.join('\n')
}

const replyFormat = (r, prs) => {
  const line = `\`file:line — severity — confidence — blocking|non-blocking — finding\`, where severity is one of ` +
    `${r.severities.join(', ')} and confidence is ${r.confidence.replace(/\.$/, '')}`
  return prs.length === 1
    ? 'Do not publish. Your final reply is the review itself, and nothing follows it:\n' +
      `- every finding on its own line as ${line}\n` +
      '- `None.` on its own line if you have no findings\n' +
      '- then one final line: `Recommendation: merge` or `Recommendation: do not merge`'
    : 'Do not publish. Your final reply is the reviews themselves, one section per pull request, in this order: ' +
      `${prs.map((p) => `#${p.pr}`).join(', ')}. Each section opens with a heading line \`## PR #<number>\`, then:\n` +
      `- every finding for that pull request on its own line as ${line}\n` +
      '- `None.` on its own line if it has no findings\n' +
      '- then that pull request\'s own line: `Recommendation: merge` or `Recommendation: do not merge`'
}

const reviewerPrompt = (rendered, r, prs) => `${context(prs)}\n\n${rendered}\n\n${replyFormat(r, prs)}`

const dispatchOne = (agentType, prompt) =>
  'This is a review evaluation, and you stand in for the orchestrate workflow\'s dispatch step. Make exactly one ' +
  `Agent tool call, with subagent_type \`${agentType}\` and, as its prompt, the text between the BEGIN PROMPT and ` +
  'END PROMPT lines below, copied verbatim. Do not review the change yourself, read no files, and add nothing to the ' +
  'prompt. When the agent returns, reply with its final report verbatim and nothing else.\n\n' +
  `BEGIN PROMPT\n${prompt}\nEND PROMPT\n`

const dispatchMany = (agentType, prompts, prs) =>
  'This is a review evaluation, and you stand in for the orchestrate workflow\'s dispatch step. Make exactly ' +
  `${prompts.length} Agent tool calls, one per prompt below, each with subagent_type \`${agentType}\` and, as its ` +
  'prompt, the text between its BEGIN PROMPT and END PROMPT lines, copied verbatim. They may run in parallel. Do not ' +
  'review the changes yourself, read no files, and add nothing to the prompts. When every agent has returned, reply ' +
  'with their final reports verbatim and nothing else, in the order below, each under a heading line ' +
  '`## PR #<number>` naming its pull request.\n\n' +
  prompts.map((p, i) => `Prompt ${i + 1}, for pull request #${prs[i].pr}:\n\nBEGIN PROMPT\n${p}\nEND PROMPT\n`).join('\n')

// ------------------------------------------------------------------ the generated files
const SINGLE = [{ pr: 1412, issue: 412 }]
const BATCH = BATCH_ISSUES.map((issue) => ({ pr: prOf(issue), issue }))

export const tagsOf = (yaml) => (/^tags:\s*\[([^\]]*)\]/m.exec(yaml)?.[1] || '').split(',').map((t) => t.trim()).filter(Boolean)

const caseYaml = (name, tags, scaffold) => [
  '# Generated by scripts/eval-build.mjs from the case\'s name and tags. Edit the tags, then re-run it.',
  'schema_version: "1.1"',
  `name: ${name}`,
  `tags: [${tags.join(', ')}]`,
  'runs: 1',
  'context:',
  `  scaffold_script: ${scaffold}`,
  'execution:',
  // The dispatcher needs a turn or two; the reviewer's own turns are bounded by its agent's
  // maxTurns. A full review on the session model can take many minutes.
  '  max_turns: 12',
  '  timeout_seconds: 1800',
  '  allowed_tools: [Agent, Read, Skill]',
  '',
].join('\n')

const scaffoldSh = (fixtureFromCase) => [
  '#!/usr/bin/env bash',
  '# Generated by scripts/eval-build.mjs. Builds this case\'s fixture repository in the empty workspace.',
  'set -euo pipefail',
  'here="$(cd "$(dirname "$0")" && pwd)"',
  `root="$here/${fixtureFromCase.root}"`,
  `exec node "$root/scripts/eval-scaffold.mjs" "$root/${fixtureFromCase.fixture}"`,
  '',
].join('\n')

const dispatchGrader = (agentType, min) => [
  '---',
  'type: tool_used',
  'tool: Agent',
  `input_match: '"subagent_type"\\s*:\\s*"${agentType}"'`,
  `min: ${min}`,
  '---',
  '',
  `Generated by scripts/eval-build.mjs. The run dispatched the ${agentType} agent${min > 1 ? ` ${min} times` : ''}, whose skills: ` +
    'frontmatter preloads the review procedure. A run that answered without it reviewed nothing with the plugin, so ' +
    'scripts/eval-tiers.mjs counts it as invalid, not as a hit or a miss.',
  '',
].join('\n')

export const caseDirs = () => (existsSync(EVALS)
  ? readdirSync(EVALS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !['results', 'full'].includes(e.name) && existsSync(join(EVALS, e.name, 'case.yaml')))
    .map((e) => e.name).sort()
  : [])

// Every generated file, by path relative to the repository root.
export async function generate(src = workflowSource()) {
  const r = await renderReviewPrompts(src)
  const files = new Map()
  const graderFiles = (dir) => (existsSync(join(EVALS, dir, 'graders'))
    ? readdirSync(join(EVALS, dir, 'graders')).filter((g) => g.endsWith('.md') && g !== 'review-agent-dispatched.md').sort()
    : [])
  for (const name of caseDirs()) {
    const dir = join(EVALS, name)
    const tags = tagsOf(readFileSync(join(dir, 'case.yaml'), 'utf8'))
    const rel = (p) => relative(ROOT, p)
    if (name === BATCH_CASE || name === PER_PR_CASE) {
      const prompt = name === BATCH_CASE
        ? dispatchOne(r.agentType, reviewerPrompt(r.batch, r, BATCH))
        : dispatchMany(r.agentType, r.perPr.map((p, i) => reviewerPrompt(p, r, [BATCH[i]])), BATCH)
      files.set(rel(join(dir, 'case.yaml')), caseYaml(name, tags, 'scaffold.sh'))
      files.set(rel(join(dir, 'prompt.md')), prompt)
      files.set(rel(join(dir, 'scaffold.sh')), scaffoldSh({ root: '../..', fixture: `evals/${BATCH_CASE}/fixture.txt` }))
      files.set(rel(join(dir, 'graders', 'review-agent-dispatched.md')), dispatchGrader(r.agentType, name === BATCH_CASE ? 1 : BATCH.length))
      continue
    }
    const scopes = [['light', dir, name, r.light], ['full', join(EVALS, 'full', name), `${name}-full`, r.full]]
    for (const [scope, d, caseName, rendered] of scopes) {
      const t = [`${scope}-review`, ...tags.filter((x) => !/^(light|full)-review$/.test(x))]
      files.set(rel(join(d, 'case.yaml')), caseYaml(caseName, t, 'scaffold.sh'))
      files.set(rel(join(d, 'prompt.md')), dispatchOne(r.agentType, reviewerPrompt(rendered, r, SINGLE)))
      files.set(rel(join(d, 'scaffold.sh')), scaffoldSh({ root: scope === 'light' ? '../..' : '../../..', fixture: `evals/${name}/fixture.txt` }))
      files.set(rel(join(d, 'graders', 'review-agent-dispatched.md')), dispatchGrader(r.agentType, 1))
      if (scope === 'full') for (const g of graderFiles(name)) files.set(rel(join(d, 'graders', g)), readFileSync(join(dir, 'graders', g), 'utf8'))
    }
  }
  return files
}

export function stale(files) {
  const out = []
  for (const [p, body] of files) {
    const f = join(ROOT, p)
    if (!existsSync(f) || readFileSync(f, 'utf8') !== body) out.push(p)
  }
  // A full-scope copy with no light case, or a grader the light case no longer has, is stale too.
  const fullRoot = join(EVALS, 'full')
  if (existsSync(fullRoot)) {
    for (const e of readdirSync(fullRoot, { withFileTypes: true }).filter((x) => x.isDirectory())) {
      const gd = join(fullRoot, e.name, 'graders')
      const listed = [join(fullRoot, e.name, 'case.yaml'), ...(existsSync(gd) ? readdirSync(gd).map((g) => join(gd, g)) : [])]
      for (const f of listed) if (!files.has(relative(ROOT, f))) out.push(`${relative(ROOT, f)} (not generated: remove it)`)
    }
  }
  return out
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const check = process.argv.includes('--check')
  const files = await generate()
  const out = stale(files)
  if (check) {
    if (out.length) {
      console.log(`${out.length} generated eval file(s) out of date; run node scripts/eval-build.mjs:`)
      for (const p of out) console.log(`  ${p}`)
      process.exit(1)
    }
    console.log(`${files.size} generated eval files are up to date.`)
  } else {
    for (const [p, body] of files) {
      mkdirSync(dirname(join(ROOT, p)), { recursive: true })
      writeFileSync(join(ROOT, p), body)
      if (p.endsWith('.sh')) chmodSync(join(ROOT, p), 0o755)
    }
    const left = out.filter((p) => p.endsWith('(not generated: remove it)'))
    console.log(`wrote ${files.size} generated eval files.${left.length ? ` Remove by hand:\n  ${left.join('\n  ')}` : ''}`)
  }
}
