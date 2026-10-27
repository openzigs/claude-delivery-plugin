#!/usr/bin/env node
//
// Static prompt footprint per dispatch. Stdlib only, read-only, free and deterministic.
//
//   node scripts/footprint.mjs                       # the working tree
//   node scripts/footprint.mjs --ref 6567d82 --ref HEAD   # one column per ref (6567d82 is 0.7.1)
//   node scripts/footprint.mjs --ref HEAD --json
//
// For every dispatch the two workflows make, the fixed prefix a dispatched agent pays before
// it does any work:
//   agent    the dispatched agent's body (its system prompt; frontmatter is not sent to it)
//   skills   every skill it carries before its first tool result: each `skills:` preload, plus
//            each `/delivery:<skill>` the prompt names (a slash name cues a Skill call, so a
//            preloaded skill named again is paid twice, and counted twice)
//   refs     reference files every run of that dispatch must read (see below)
//   prompt   the prompt the workflow builds, rendered by running workflows/*.js against a stub
//            agent() whose review and fix answers are one short line each
// The project's CLAUDE.md, Claude Code's own system prompt and tool definitions are NOT
// counted: they are the same for every ref, so they cannot change a comparison. A reference
// file the skill orders every run of that dispatch to read is counted (refs): the full review
// reads code-review/FULL_REVIEW_STEPS.md, the light review does not. Files read only when a
// situation arises (MERGE_CONFLICTS.md, LIVING_DOCS.md) are not a fixed cost and are not counted.
// Tokens are approximate: bytes / 4.
//
// The workflow scripts at a ref are executed (against stubs, with no network and no gh) to
// render their prompts, so only pass refs of this repository you would run anyway.
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The ceiling the verifier holds the code-issue and code-review dispatches to, in bytes. Set
// from the measurement at the commit that introduced it plus about 5% headroom, so ordinary
// edits pass and a silent re-bloat (a reference file folded back into a preloaded skill, a
// second load of the same skill) fails. Raise it in the PR that needs to, with the reason.
// Measured at introduction: implement 17,925, full review 25,347 (21,243 + the 4,104 B
// FULL_REVIEW_STEPS.md it reads), light review 21,971, fix 18,107, re-review 25,695 bytes
// (0.7.1 was 30-32 KB for each).
export const CEILINGS = {
  implement: 18800,
  'full review': 26600,
  'light review': 23100,
  fix: 19000,
  're-review': 27000,
}

// A reader returns a file's text, or null if the file does not exist there.
export const worktreeReader = (root = ROOT) => (p) => {
  const f = join(root, p)
  return existsSync(f) ? readFileSync(f, 'utf8') : null
}
export function refReader(ref, root = ROOT) {
  // A ref starting with '-' would reach git as an option (`git show --output=...`).
  if (!ref || ref.startsWith('-')) throw new Error(`not a git ref: ${JSON.stringify(ref)}`)
  const sha = execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    { encoding: 'utf8' }).trim()
  return (p) => {
    try {
      return execFileSync('git', ['-C', root, 'show', `${sha}:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { return null }
  }
}

const body = (md) => (md.startsWith('---\n') ? md.slice(md.indexOf('\n---', 4) + 4).replace(/^\n/, '') : md)
const preloads = (md) => {
  const fm = md.startsWith('---\n') ? md.slice(4, md.indexOf('\n---', 4)) : ''
  const line = /^skills:[ \t]*(.*)$/m.exec(fm)
  if (!line) return []
  const inline = line[1].trim()
  if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
  const after = fm.slice(line.index + line[0].length).split('\n')
  const list = []
  for (const l of after.slice(1)) { const m = /^\s+-\s*(\S+)/.exec(l); if (!m) break; list.push(m[1]) }
  return list
}
const bytes = (s) => Buffer.byteLength(s || '', 'utf8')

// The stub review and fix are deliberately short: the prompt column measures what the
// workflow writes, not what a real review would add.
const REVIEW = (blocking) => ({
  pr: 1412, recommendation: blocking ? 'Recommendation: do not merge' : 'Recommendation: merge', blocking,
  findings: [{ severity: blocking ? 'high' : 'nit', location: 'a.js:1', summary: 'stub finding', blocking }],
  verification: 'stub',
})
const FIX = { changed: [{ finding: 'stub finding', fix: 'stub fix', test: 'stub test' }], declined: [], gates: { passed: true, pushed: true } }
const FULL = { storyPoints: 5, labels: ['enhancement'], filesChanged: 3, linesChanged: 80 }
const LIGHT = { storyPoints: 1, labels: [], filesChanged: 2, linesChanged: 40 }

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
async function render(src, argv, facts, blocking) {
  const dispatches = []
  const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', 'budget',
    src.replace(/export const meta = \{[\s\S]*?\n\}\n/, ''))
  await fn(argv, async (prompt, o = {}) => {
    dispatches.push({ prompt, ...o })
    if (o.schema?.properties?.issues) {
      return { issues: [{ issue: 412, pr: 1412, headRefName: 'feature/issue-412-x', ...facts, report: 'stub' }] }
    }
    if (o.schema?.properties?.changed) return FIX
    if (o.schema) return REVIEW(blocking)
    return ''
  }, () => {}, () => {}, (ts) => Promise.all(ts.map((t) => t())), undefined)
  return dispatches
}

// The seven dispatches, each picked out of a stub run by its label.
const DISPATCHES = [
  ['implement', 'orchestrate', FULL, true, 'implement:'],
  ['full review', 'orchestrate', FULL, true, 'review:'],
  ['light review', 'orchestrate', LIGHT, false, 'review:'],
  ['fix', 'orchestrate', FULL, true, 'fix:'],
  ['re-review', 'orchestrate', FULL, true, 'rereview:'],
  ['research', 'plan-epic', null, false, 'research'],
  ['plan', 'plan-epic', null, false, 'plan'],
]

export async function measure(read) {
  const rows = []
  const runs = new Map()
  for (const [name, wf, facts, blocking, label] of DISPATCHES) {
    const src = read(`workflows/${wf}.js`)
    if (!src) { rows.push({ dispatch: name, missing: `workflows/${wf}.js` }); continue }
    const key = `${wf}|${JSON.stringify(facts)}|${blocking}`
    if (!runs.has(key)) runs.set(key, await render(src, wf === 'orchestrate' ? '412' : 'a stub topic', facts, blocking))
    const d = runs.get(key).find((x) => (x.label || '').startsWith(label))
    if (!d) { rows.push({ dispatch: name, missing: 'no such dispatch at this ref' }); continue }
    const agentName = String(d.agentType || '').replace(/^delivery:/, '')
    const agentMd = read(`agents/${agentName}.md`) || ''
    const named = [...d.prompt.matchAll(/\/delivery:([a-z0-9-]+)/g)].map((m) => m[1])
    const skills = [...preloads(agentMd).map((s) => s.replace(/^delivery:/, '')), ...named]
    const skillTexts = skills.map((s) => read(`skills/${s}/SKILL.md`)).filter((t) => t != null)
    // A skill that names FULL_REVIEW_STEPS.md makes every full-scope review read it. The light
    // review's prompt carries the LIGHT scope paragraph and skips it.
    const refTexts = skills.includes('code-review') && /FULL_REVIEW_STEPS\.md/.test(read('skills/code-review/SKILL.md') || '') && !/Review scope: LIGHT/.test(d.prompt)
      ? [read('skills/code-review/FULL_REVIEW_STEPS.md')].filter((t) => t != null) : []
    const refBytes = refTexts.reduce((n, t) => n + bytes(t), 0)
    const agentBytes = bytes(body(agentMd))
    const skillBytes = skillTexts.reduce((n, t) => n + bytes(body(t)), 0)
    const promptBytes = bytes(d.prompt)
    const total = agentBytes + skillBytes + refBytes + promptBytes
    rows.push({ dispatch: name, agent: d.agentType, skills, agentBytes, skillBytes, refBytes, promptBytes, total, tokens: Math.round(total / 4) })
  }
  const sum = (names) => {
    const picked = names.map((n) => rows.find((r) => r.dispatch === n))
    return picked.every((r) => r && r.total != null) ? picked.reduce((n, r) => n + r.total, 0) : null
  }
  return {
    rows,
    cycles: {
      'no-fix cycle (implement + full review)': sum(['implement', 'full review']),
      'blocking cycle (+ fix + re-review)': sum(['implement', 'full review', 'fix', 're-review']),
      'plan-epic (research + plan)': sum(['research', 'plan']),
    },
  }
}

// The dispatches over their ceiling. Only code-issue and code-review dispatches have one.
export function overCeiling(m, ceilings = CEILINGS) {
  return m.rows.filter((r) => ceilings[r.dispatch] != null && (r.total == null || r.total > ceilings[r.dispatch]))
    .map((r) => ({ dispatch: r.dispatch, total: r.total ?? null, ceiling: ceilings[r.dispatch] }))
}

const fmtN = (n) => (n == null ? 'n/a' : `${n.toLocaleString('en-US')} B / ~${Math.round(n / 4).toLocaleString('en-US')} tok`)

export function table(cols) {
  const head = ['dispatch', ...cols.map((c) => c.name)]
  if (cols.length === 2) head.push('change')
  const names = [...new Set(cols.flatMap((c) => c.m.rows.map((r) => r.dispatch)))]
  const lines = []
  const delta = (a, b) => (a == null || b == null || !a ? '' : `${b - a >= 0 ? '+' : ''}${Math.round(((b - a) / a) * 100)}%`)
  for (const n of names) {
    const vals = cols.map((c) => c.m.rows.find((r) => r.dispatch === n)?.total ?? null)
    lines.push([n, ...vals.map(fmtN), ...(cols.length === 2 ? [delta(vals[0], vals[1])] : [])])
  }
  for (const k of Object.keys(cols[0].m.cycles)) {
    const vals = cols.map((c) => c.m.cycles[k])
    lines.push([k, ...vals.map(fmtN), ...(cols.length === 2 ? [delta(vals[0], vals[1])] : [])])
  }
  const all = [head, ...lines]
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)))
  const row = (r) => `| ${r.map((c, i) => String(c ?? '').padEnd(w[i])).join(' | ')} |`
  return [row(head), `|${w.map((x) => '-'.repeat(x + 2)).join('|')}|`, ...lines.map(row)].join('\n')
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const refs = []
  let asJson = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') asJson = true
    else if (argv[i] === '--ref' && argv[i + 1]) refs.push(argv[++i])
    else if (argv[i].startsWith('--ref=')) refs.push(argv[i].slice(6))
    else { console.error('usage: node scripts/footprint.mjs [--ref <git-ref>]... [--json]'); process.exit(2) }
  }
  const cols = []
  try {
    for (const ref of refs.length ? refs : [null]) {
      cols.push({ name: ref ?? 'working tree', m: await measure(ref ? refReader(ref) : worktreeReader()) })
    }
  } catch (e) { console.error(`footprint: ${e.message.split('\n')[0]}`); process.exit(2) }
  if (asJson) console.log(JSON.stringify({ columns: cols.map((c) => ({ ref: c.name, ...c.m })), ceilings: CEILINGS }, null, 2))
  else {
    console.log(table(cols))
    console.log('\nFixed prefix per dispatch: agent body + preloaded and prompt-named skills + mandatory reference files + the rendered prompt.')
    console.log('Excludes the project CLAUDE.md, Claude Code\'s system prompt and tools, and files read only on demand. Tokens ~ bytes/4.')
  }
}
