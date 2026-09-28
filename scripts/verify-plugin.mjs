#!/usr/bin/env node
//
// Structural verification for this plugin. Stdlib only, no dependencies.
//
//   node scripts/verify-plugin.mjs
//
// Checks, in order:
//   1. plugin.json is valid JSON with the required fields
//   2. every agent's frontmatter parses, has name + description, uses only
//      supported fields, and has a `name` matching its filename stem
//   3. every Agent(...) reference is namespaced and resolves to a real agent
//   4. every skill lives in its own directory with a SKILL.md whose `name`
//      matches that directory
//   5. every workflow parses as JavaScript
//   6. every workflow's `meta` is a PURE LITERAL -- the runtime reads it without
//      executing the module, so a variable, a call, a template interpolation or
//      even a `+` concatenation is rejected
//   7. every workflow body actually runs, against stubbed agent/phase/log, and
//      produces the intended phase order -- including the conditional branches,
//      which are driven by the review's structured output
//
// It exists because every one of those failures is silent at runtime.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (m) => console.log(`  PASS  ${m}`)
const bad = (m) => { fails++; console.log(`  FAIL  ${m}`) }

// ---------------------------------------------------------------- plugin.json
console.log('\n== .claude-plugin/plugin.json ==')
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'))
for (const f of ['name', 'version', 'description', 'author']) {
  manifest[f] ? ok(`has ${f}`) : bad(`missing ${f}`)
}
manifest.name === 'delivery' ? ok('name is "delivery"') : bad(`name is ${manifest.name}`)

// -------------------------------------------------------------------- agents
console.log('\n== agents/ ==')
const agentFiles = readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).sort()
const agentNames = new Set()

// Minimal YAML frontmatter reader: top-level `key: value` only, which is all the
// agent schema uses. Also verifies the block is well-formed YAML-ish (no tabs,
// every non-continuation line is `key: value`).
function frontmatter(src, file) {
  const lines = src.split('\n')
  if (lines[0] !== '---') { bad(`${file}: does not start with ---`); return null }
  const end = lines.indexOf('---', 1)
  if (end === -1) { bad(`${file}: unterminated frontmatter`); return null }
  const out = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (line.includes('\t')) { bad(`${file}: tab in frontmatter line ${i + 1}`); return null }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line)
    if (!m) { bad(`${file}: unparseable frontmatter line ${i + 1}: ${line}`); return null }
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

const KNOWN = new Set(['name', 'description', 'tools', 'disallowedTools', 'model',
  'effort', 'color', 'skills', 'permissionMode', 'maxTurns', 'initialPrompt'])

for (const file of agentFiles) {
  const stem = basename(file, '.md')
  const fm = frontmatter(readFileSync(join(ROOT, 'agents', file), 'utf8'), file)
  if (!fm) continue
  agentNames.add(stem)
  if (!fm.name) bad(`${file}: no name`)
  else if (fm.name !== stem) bad(`${file}: name "${fm.name}" != filename stem "${stem}"`)
  else if (!/^[a-z][a-z0-9-]*$/.test(fm.name)) bad(`${file}: name not lowercase/hyphen`)
  else ok(`${file}: name ok`)
  if (!fm.description) bad(`${file}: no description`)
  const unknown = Object.keys(fm).filter((k) => !KNOWN.has(k))
  if (unknown.length) bad(`${file}: unsupported frontmatter field(s): ${unknown.join(', ')}`)
}

// every Agent(...) reference must be namespaced and resolve to a real agent
for (const file of agentFiles) {
  const src = readFileSync(join(ROOT, 'agents', file), 'utf8')
  const fm = frontmatter(src, file)
  const m = /Agent\(([^)]*)\)/.exec(fm?.tools || '')
  if (!m) continue
  for (const ref of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!ref.startsWith('delivery:')) bad(`${file}: Agent ref "${ref}" not namespaced`)
    else if (!agentNames.has(ref.slice('delivery:'.length))) bad(`${file}: Agent ref "${ref}" has no such agent`)
    else ok(`${file}: Agent(${ref}) resolves`)
  }
}

// -------------------------------------------------------------------- skills
console.log('\n== skills/ ==')
for (const dir of readdirSync(join(ROOT, 'skills')).sort()) {
  const p = join(ROOT, 'skills', dir, 'SKILL.md')
  if (!existsSync(p)) { bad(`skills/${dir}: no SKILL.md`); continue }
  const fm = frontmatter(readFileSync(p, 'utf8'), `skills/${dir}/SKILL.md`)
  if (!fm) continue
  if (fm.name !== dir) bad(`skills/${dir}: name "${fm.name}" != directory`)
  else if (!fm.description) bad(`skills/${dir}: no description`)
  else ok(`skills/${dir}: frontmatter ok (${fm.description.length} char description)`)
}

// ----------------------------------------------------------------- workflows
console.log('\n== workflows/ ==')

function extractMeta(src) {
  const i = src.indexOf('export const meta')
  const open = src.indexOf('{', i)
  let depth = 0, j = open, inStr = null, esc = false
  for (; j < src.length; j++) {
    const c = src[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth === 0) break }
  }
  return src.slice(open, j + 1)
}

// A "pure literal" is an object of literals: no identifiers except keys, no
// calls, no operators, no template interpolation. Strip string contents first,
// then anything left must be punctuation and `key:` tokens.
function purityViolations(metaSrc) {
  const stripped = metaSrc.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
  const bad = []
  if (metaSrc.includes('${')) bad.push('template interpolation ${')
  if (/`/.test(metaSrc)) bad.push('template literal backtick')
  if (/[()]/.test(stripped)) bad.push('call or parenthesised expression')
  for (const op of ['+', '?', '=>', '...']) if (stripped.includes(op)) bad.push(`operator ${op}`)
  const idents = stripped.match(/[A-Za-z_$][A-Za-z0-9_$]*\s*:?/g) || []
  for (const t of idents) if (!t.trim().endsWith(':')) bad.push(`bare identifier "${t.trim()}"`)
  return bad
}

const CLEAN_REVIEW = {
  pr: 7, recommendation: 'Recommendation: merge — no blocking findings', blocking: false,
  findings: [{ severity: 'nit', location: 'a.ts:1', summary: 'naming', blocking: false }],
  verification: 'ran the suite',
}
const BLOCKING_REVIEW = {
  ...CLEAN_REVIEW, recommendation: 'Recommendation: do not merge — 1 blocking finding', blocking: true,
  findings: [{ severity: 'high', location: 'db.ts:9', summary: 'missing scope column', blocking: true }],
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflowFiles = readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.js')).sort()

for (const file of workflowFiles) {
  const src = readFileSync(join(ROOT, 'workflows', file), 'utf8')

  // 1. parses as JS (as an ES module body)
  try { new AsyncFunction(src.replace(/^export /m, '')); ok(`${file}: parses as JavaScript`) }
  catch (e) { bad(`${file}: syntax error — ${e.message}`); continue }

  // 2. meta is a pure literal
  const metaSrc = extractMeta(src)
  const v = purityViolations(metaSrc)
  v.length ? bad(`${file}: meta not a pure literal — ${v.join('; ')}`) : ok(`${file}: meta is a pure literal`)

  // 3. meta evaluates with no globals available at all
  let meta
  try {
    meta = new Function(`"use strict"; return ${metaSrc}`).call(undefined)
    ok(`${file}: meta evaluates standalone (name=${meta.name}, ${meta.phases.length} phases)`)
  } catch (e) { bad(`${file}: meta will not evaluate — ${e.message}`); continue }
  if (meta.name !== basename(file, '.js')) bad(`${file}: meta.name "${meta.name}" != filename stem`)
  if (!meta.description || !meta.whenToUse) bad(`${file}: meta missing description/whenToUse`)

  // 4. run the body with stubbed agent/phase/log and check the phase order
  const body = src.replace(/export const meta = \{[\s\S]*?\n\}\n/, '')
  for (const [label, argv] of [['with an issue number', '412'], ['with a description', 'make the export honour a date range'], ['with no args', '']]) {
    const phases = [], dispatches = [], logs = []
    const fn = new AsyncFunction('args', 'agent', 'phase', 'log', body)
    try {
      const result = await fn(
        argv,
        async (prompt, opts = {}) => {
          dispatches.push({ label: opts.label, phase: opts.phase, agentType: opts.agentType || null, promptLen: prompt.length })
          if (opts.schema) return CLEAN_REVIEW
          return `[stub output for ${opts.label}]`
        },
        (t) => phases.push(t),
        (m) => logs.push(m),
      )
      const expected = file === 'orchestrate.js'
        ? ['Implement', 'Review', 'Fix']
        : ['Research', 'Plan']
      JSON.stringify(phases) === JSON.stringify(expected)
        ? ok(`${file} ${label}: phase order ${phases.join(' -> ')}`)
        : bad(`${file} ${label}: phase order ${phases.join(' -> ')} != ${expected.join(' -> ')}`)
      for (const d of dispatches) {
        if (!d.agentType?.startsWith('delivery:')) bad(`${file}: dispatch "${d.label}" has agentType ${d.agentType}`)
      }
      if (argv === '412' && file === 'orchestrate.js') {
        result.issue === '412' ? ok('orchestrate.js: bare number parsed as issue 412') : bad(`issue parsed as ${result.issue}`)
      }
      if (argv.startsWith('make the') && file === 'orchestrate.js') {
        result.issue === null && !JSON.stringify(dispatches).includes('issue #make')
          ? ok('orchestrate.js: description not mangled into a fake issue reference')
          : bad('orchestrate.js: description became a fake issue reference')
      }
      if (argv === '' && logs.length === 0) bad(`${file}: no usage hint logged for empty args`)
    } catch (e) { bad(`${file} ${label}: threw — ${e.message}`) }
  }

  // 5. the fix branch is decided by the review's structured output, not by prose.
  //    Exercise every way a review can come back.
  if (file === 'orchestrate.js') {
    const run = async (review) => {
      const phases = [], dispatches = []
      const fn = new AsyncFunction('args', 'agent', 'phase', 'log', body)
      const result = await fn('412',
        async (p, o = {}) => { dispatches.push(o); return o.schema ? review : `[stub ${o.label}]` },
        (t) => phases.push(t), () => {})
      return { phases, dispatches, result }
    }
    const reviewDispatchesHaveSchema = (ds) =>
      ds.filter((d) => d.agentType === 'delivery:code-review').every((d) => d.schema?.properties?.blocking)

    let r = await run(BLOCKING_REVIEW)
    JSON.stringify(r.phases) === JSON.stringify(['Implement', 'Review', 'Fix', 'Re-review'])
      && r.result.blockingFindings && r.result.fix && r.result.reReview && r.result.merged === false
      ? ok(`orchestrate.js blocking review: ${r.phases.join(' -> ')}, merged=false`)
      : bad(`orchestrate.js blocking review: ${r.phases.join(' -> ')}`)
    reviewDispatchesHaveSchema(r.dispatches)
      ? ok('orchestrate.js: every review dispatch carries the structured-output schema')
      : bad('orchestrate.js: a review dispatch is missing the schema')
    r.dispatches.every((d) => d.agentType?.startsWith('delivery:'))
      ? ok('orchestrate.js: no untyped helper agents (no preflight/triage dispatch)')
      : bad(`orchestrate.js: untyped dispatch ${r.dispatches.filter((d) => !d.agentType).map((d) => d.label)}`)

    // top-level flag false but one finding blocking -> still a fix pass
    r = await run({ ...CLEAN_REVIEW, findings: [{ ...BLOCKING_REVIEW.findings[0] }] })
    r.phases.includes('Fix') && r.result.fix
      ? ok('orchestrate.js: a blocking finding under blocking=false still triggers the fix')
      : bad('orchestrate.js: flag/finding disagreement skipped the fix')

    // review died -> stop loudly, never report as reviewed
    r = await run(null)
    r.result.reviewCompleted === false && !r.phases.includes('Fix')
      ? ok('orchestrate.js: a review that never returned stops the run as unreviewed')
      : bad('orchestrate.js: a missing review was treated as clean')
  }
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
