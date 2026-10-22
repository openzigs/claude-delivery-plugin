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
//      and every `skills:` entry is namespaced, names a real skill directory,
//      and code-issue / code-review declare their own
//   4. every skill lives in its own directory with a SKILL.md whose `name`
//      matches that directory
//   5. every workflow parses as JavaScript
//   6. every workflow's `meta` is a PURE LITERAL -- the runtime reads it without
//      executing the module, so a variable, a call, a template interpolation or
//      even a `+` concatenation is rejected
//   7. every workflow body actually runs, against stubbed agent/phase/log/parallel, and
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

// every preloaded `skills:` entry must be namespaced and name a real skill
// directory (matched against the directory names, so `../` tricks fail). Claude
// Code skips a missing one with only a debug-log warning, so a typo leaves the
// agent with no procedure at all. A bare name is rejected because it can match
// a same-named skill from elsewhere (the built-in `code-review`, for one).
// The two procedure agents must also declare theirs: their fallback text says
// the body is preloaded, so a silent removal would leave them with none.
const skillDirs = new Set(readdirSync(join(ROOT, 'skills')))
const MUST_PRELOAD = { 'code-issue': 'delivery:code-issue', 'code-review': 'delivery:code-review' }
for (const file of agentFiles) {
  const stem = basename(file, '.md')
  const fm = frontmatter(readFileSync(join(ROOT, 'agents', file), 'utf8'), file)
  const refs = (fm?.skills || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (MUST_PRELOAD[stem] && !refs.includes(MUST_PRELOAD[stem])) {
    bad(`${file}: must declare skills: ${MUST_PRELOAD[stem]}`)
  }
  for (const ref of refs) {
    if (!ref.startsWith('delivery:')) bad(`${file}: skills entry "${ref}" not namespaced`)
    else if (!skillDirs.has(ref.slice('delivery:'.length))) bad(`${file}: skills entry "${ref}" has no such skill`)
    else ok(`${file}: skills ${ref} resolves`)
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

// The orient steps of the two procedure skills are one batched Bash call, then one
// response of parallel reads: every separate fetch is a full model turn over a
// growing context. The batch is joined with `;`, never `&&`, so a missing
// .claude/delivery.md or a PR with no checks does not abort the rest of it.
const sectionOf = (src, heading) => {
  const i = src.indexOf(heading)
  if (i === -1) return ''
  const rest = src.slice(i + heading.length)
  const end = rest.search(/\n#{2,3} /)
  return end === -1 ? rest : rest.slice(0, end)
}
const bashBlocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
const checkSkill = (cond, msg) => (cond ? ok(msg) : bad(msg))
{
  const review = readFileSync(join(ROOT, 'skills/code-review/SKILL.md'), 'utf8')
  const orient = sectionOf(review, '### Step 1: Orient')
  const blocks = bashBlocks(orient)
  const batch = blocks[0] || ''
  checkSkill(blocks.length === 1, `code-review Orient has exactly one batched Bash call (found ${blocks.length})`)
  checkSkill(['gh pr view', 'files', 'gh pr diff', 'gh pr checks', 'cat .claude/delivery.md 2>/dev/null'].every((t) => batch.includes(t)),
    'code-review Orient batch fetches PR, files, diff, checks and .claude/delivery.md')
  checkSkill(!batch.includes('&&'), 'code-review Orient batch is joined with ; so one failure does not abort it')
  checkSkill(!/--json files/.test(review), 'code-review has no separate --json files fetch')
  checkSkill(/single response/i.test(orient) && /in full/i.test(orient), 'code-review Orient reads every changed file in full, in parallel in a single response')
  checkSkill(!/If\s+`\.claude\/delivery\.md` exists, read it/.test(sectionOf(review, '## Step 0')),
    'code-review Step 0 folds the .claude/delivery.md read into the Orient batch')

  const issue = readFileSync(join(ROOT, 'skills/code-issue/SKILL.md'), 'utf8')
  const plan = sectionOf(issue, '### Step 1: Planning')
  const iblocks = bashBlocks(plan)
  checkSkill(iblocks.length === 1 && ['gh issue view', 'cat .claude/delivery.md 2>/dev/null'].every((t) => iblocks[0].includes(t)) && !iblocks[0].includes('&&'),
    'code-issue Step 1 has one ;-joined batch fetching the issue and .claude/delivery.md')
  checkSkill(/single response/i.test(plan), 'code-issue Step 1 reads files in parallel in a single response')
  checkSkill(!/If\s+`\.claude\/delivery\.md` exists, read it/.test(sectionOf(issue, '## Step 0')),
    'code-issue Step 0 folds the .claude/delivery.md read into the Step 1 batch')
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

// What the fix agent reports. The declined reason is a sentinel so a test can
// prove the structured result reaches the re-reviewer rather than being dropped.
const FIX_RESULT = {
  changed: [{ finding: 'missing scope column', fix: 'filter on tenant_id', test: 'db.test.ts scoped read' }],
  declined: [{ finding: 'naming', reason: 'SENTINEL-DECLINED-REASON' }],
  gates: { passed: true, pushed: true, detail: 'suite green' },
}

// What the implementer reports for an issue, by case: the issue's own points
// and labels, and its PR's size. These drive the review routing.
const MEDIUM_ISSUE = { storyPoints: 5, labels: ['enhancement'], filesChanged: 3, linesChanged: 80 }
const SMALL_ISSUE = { storyPoints: 2, labels: ['bug'], filesChanged: 2, linesChanged: 40 }
const AT_LIMIT_ISSUE = { storyPoints: 1, labels: [], filesChanged: 5, linesChanged: 150 }

// Planted in every stub implementer report, so a test can prove the report never
// reaches a reviewer's prompt: the reviewer reads the PR, not the author's account.
const REPORT_SENTINEL = 'SENTINEL-IMPLEMENTER-REPORT'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflowFiles = readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.js')).sort()
const stubParallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))

// Consecutive-distinct phases, whether set by phase() or by an agent's opts.phase.
function runner(body) {
  return async ({ argv = '412', review = CLEAN_REVIEW, facts = {}, implement, fix = FIX_RESULT } = {}) => {
    const dispatches = [], logs = [], seq = []
    let current = null
    const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', body)
    const result = await fn(
      argv,
      async (prompt, o = {}) => {
        const p = o.phase || current
        if (seq[seq.length - 1] !== p) seq.push(p)
        dispatches.push({ ...o, prompt })
        if (o.schema?.properties?.issues) {
          if (implement !== undefined) return typeof implement === 'function' ? implement(o) : implement
          const ids = o.label.slice('implement:'.length).split('+').map((x) => (x === 'task' ? 900 : Number(x)))
          return { issues: ids.map((n) => ({ issue: n, pr: n + 1000, ...MEDIUM_ISSUE, ...(facts[n] || {}), report: `${REPORT_SENTINEL} ${n}` })) }
        }
        // The fix schema must get a fix-shaped answer, not the review stub: a
        // review object here would let the phase checks pass for the wrong reason.
        if (o.schema?.properties?.changed) return fix
        if (o.schema) return typeof review === 'function' ? review(o) : review
        return `[stub ${o.label}]`
      },
      (t) => { current = t },
      (m) => logs.push(m),
      stubParallel,
    )
    return { phases: seq, dispatches, logs, result }
  }
}

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

  // 4. run the body with stubbed agent/phase/log/parallel and check the phase order
  const body = src.replace(/export const meta = \{[\s\S]*?\n\}\n/, '')
  const run = runner(body)
  for (const [label, argv] of [['with an issue number', '412'], ['with a description', 'make the export honour a date range'], ['with no args', '']]) {
    try {
      const { phases, dispatches, logs, result } = await run({ argv })
      const expected = file === 'orchestrate.js' ? ['Implement', 'Review'] : ['Research', 'Plan']
      JSON.stringify(phases) === JSON.stringify(expected)
        ? ok(`${file} ${label}: phase order ${phases.join(' -> ')}`)
        : bad(`${file} ${label}: phase order ${phases.join(' -> ')} != ${expected.join(' -> ')}`)
      for (const d of dispatches) {
        if (!d.agentType?.startsWith('delivery:')) bad(`${file}: dispatch "${d.label}" has agentType ${d.agentType}`)
      }
      if (argv === '412' && file === 'orchestrate.js') {
        JSON.stringify(result.batches?.[0]?.issues) === '[412]'
          ? ok('orchestrate.js: bare number parsed as issue 412')
          : bad(`issue parsed as ${JSON.stringify(result.batches?.[0]?.issues)}`)
      }
      if (argv.startsWith('make the') && file === 'orchestrate.js') {
        result.batches[0].issues.length === 0 && !JSON.stringify(dispatches).includes('issue #make')
          ? ok('orchestrate.js: description not mangled into a fake issue reference')
          : bad('orchestrate.js: description became a fake issue reference')
      }
      if (argv === '' && logs.length === 0) bad(`${file}: no usage hint logged for empty args`)
    } catch (e) { bad(`${file} ${label}: threw — ${e.message}`) }
  }

  if (file !== 'orchestrate.js') continue

  // 5. orchestrate.js: every routing and branching case.
  const modelOf = (ds, label) => (ds.find((d) => d.label === label) || {}).model ?? null
  const check = (cond, pass, fail) => (cond ? ok(`orchestrate.js: ${pass}`) : bad(`orchestrate.js: ${fail ?? pass}`))
  const pr0 = (r) => r.result.batches[0].prs[0]
  let r

  // --- no sizing agent
  r = await run()
  check(!r.dispatches.some((d) => d.label?.startsWith('size:') || d.agentType === 'delivery:research' || d.model === 'haiku'),
    'no separate sizing agent is dispatched')
  check(r.dispatches.length === 2, 'a clean single issue costs two agents (implement, review)', `clean run dispatched ${r.dispatches.length} agents`)
  const implSchema = r.dispatches.find((d) => d.label === 'implement:412')?.schema?.properties?.issues?.items?.properties || {}
  check(['storyPoints', 'labels', 'filesChanged', 'linesChanged', 'report'].every((k) => implSchema[k]),
    'the implementer reports points, labels and diff size as structured output')

  // --- the reviewer reads the PR body, not the implementer's own report
  r = await run({ review: BLOCKING_REVIEW })
  const reviewPrompts = r.dispatches.filter((d) => d.agentType === 'delivery:code-review')
  check(reviewPrompts.length === 2 && reviewPrompts.every((d) => !d.prompt.includes(REPORT_SENTINEL)),
    'no review or re-review prompt carries the implementer\'s report')
  check(r.dispatches.find((d) => d.label === 'review:412')?.prompt.includes('gh pr view 1412 --json body'),
    'the review prompt points the reviewer at the PR body')
  check(pr0(r).implemented?.includes(REPORT_SENTINEL) && r.result.batches[0].implemented?.[0]?.report?.includes(REPORT_SENTINEL),
    'the implementer\'s report is still in the returned result')

  // --- implementation routing on the caller's hint
  for (const [argv, want, name] of [
    ['412', null, 'no hint implements on the session model'],
    ['412 --points 2', 'sonnet', '--points 2 implements on sonnet'],
    ['412 --points=1', 'sonnet', '--points=1 implements on sonnet'],
    ['412 --small', 'sonnet', '--small implements on sonnet'],
    ['412 --points 5', null, '--points 5 implements on the session model'],
  ]) {
    r = await run({ argv })
    check(modelOf(r.dispatches, 'implement:412') === want, name, `${name} — got ${modelOf(r.dispatches, 'implement:412')}`)
  }

  // --- review routing on reported facts
  for (const [facts, want, name] of [
    [SMALL_ISSUE, 'sonnet', 'a 2-point, unlabelled-risk, small-diff PR gets a light sonnet review'],
    [AT_LIMIT_ISSUE, 'sonnet', 'a diff of exactly 5 files / 150 lines is still light'],
    [MEDIUM_ISSUE, null, 'a 5-point issue gets the full review on the session model'],
    [{ ...SMALL_ISSUE, labels: ['security'] }, null, 'a risk label forces the full review'],
    [{ ...SMALL_ISSUE, storyPoints: null }, null, 'no story points forces the full review'],
    [{ ...SMALL_ISSUE, labels: null }, null, 'unknown labels force the full review'],
    [{ ...SMALL_ISSUE, linesChanged: 151 }, null, '151 changed lines force the full review'],
    [{ ...SMALL_ISSUE, filesChanged: 6 }, null, '6 changed files force the full review'],
    [{ ...SMALL_ISSUE, filesChanged: null }, null, 'unknown diff size forces the full review'],
  ]) {
    r = await run({ facts: { 412: facts } })
    const rv = r.dispatches.find((d) => d.label === 'review:412')
    const light = rv?.prompt.includes('Review scope: LIGHT')
    check((rv?.model ?? null) === want && light === (want === 'sonnet'), name,
      `${name} — got model=${rv?.model ?? null} light=${light}`)
    check(r.logs.some((l) => l.startsWith('#412:') && l.includes('review on')), `the review routing is logged (${name})`)
  }

  // --- the fix branch is decided by structured output
  r = await run({ review: BLOCKING_REVIEW })
  check(JSON.stringify(r.phases) === JSON.stringify(['Implement', 'Review', 'Fix', 'Re-review'])
    && pr0(r).blockingFindings && pr0(r).fix && pr0(r).reReview && r.result.merged === false,
  `blocking review: ${r.phases.join(' -> ')}, merged=false`)
  check(r.dispatches.filter((d) => d.agentType === 'delivery:code-review').every((d) => d.schema?.properties?.blocking),
    'every review dispatch carries the structured-output schema')
  check(modelOf(r.dispatches, 'fix:412') === 'sonnet' && modelOf(r.dispatches, 'rereview:412') === 'sonnet',
    'after a full review, fix and re-review run on sonnet',
    `fix=${modelOf(r.dispatches, 'fix:412')} rereview=${modelOf(r.dispatches, 'rereview:412')}`)
  check(pr0(r).models?.review === 'session model' && pr0(r).models?.fix === 'sonnet',
    'the models used are reported in the result', `models = ${JSON.stringify(pr0(r).models)}`)

  // --- the procedure skills are preloaded via `skills:`, so no prompt may name one
  // as a slash skill: that cues a Skill call that loads the procedure a second time.
  check(r.dispatches.length === 4 && r.dispatches.every((d) => !/\/delivery:code-/.test(d.prompt)),
    'no dispatched prompt names a /delivery:code-* slash skill')
  check(r.dispatches.filter((d) => d.agentType !== undefined).every((d) => /\(preloaded\)/.test(d.prompt) || d.label.startsWith('fix:')),
    'implement, review and re-review prompts refer to the preloaded procedure')
  const header = src.slice(0, src.indexOf('const RULES'))
  check(/preloaded/.test(header) && /skills:/.test(header) && !/skills each agent invokes/.test(header),
    'the header comment describes skills: preload, not invocation')

  // --- orientation is batched in every dispatch, with no separate delivery.md read
  check(r.dispatches.every((d) => d.prompt.includes('cat .claude/delivery.md 2>/dev/null')
    && !/If \.claude\/delivery\.md exists, read it/.test(d.prompt)),
  'every dispatch reads .claude/delivery.md inside its batched orient call, not separately')
  // Matched on the re-review's own wording: RULES says "one batched" in every prompt.
  check((r.dispatches.find((d) => d.label === 'rereview:412')?.prompt || '').includes('PR, diff, checks and .claude/delivery.md together'),
    'the re-review prompt points at the batched orient call')

  // --- the fix returns structured output, and the re-reviewer sees it
  r = await run({ review: BLOCKING_REVIEW })
  const fixProps = r.dispatches.find((d) => d.label === 'fix:412')?.schema?.properties || {}
  check(['changed', 'declined', 'gates'].every((k) => fixProps[k]), 'the fix dispatch carries the changed/declined/gates schema')
  check(r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('SENTINEL-DECLINED-REASON'),
    'a declined finding\'s reason reaches the re-review prompt')
  check(JSON.stringify(pr0(r).fix) === JSON.stringify(FIX_RESULT), 'the structured fix result is returned')
  r = await run({ review: BLOCKING_REVIEW, fix: { ...FIX_RESULT, gates: { passed: false, pushed: false } } })
  check(r.dispatches.some((d) => d.label === 'rereview:412') && r.phases.includes('Re-review'),
    'a fix that did not push still gets its re-review')
  r = await run({ review: BLOCKING_REVIEW, fix: null })
  check(r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('did not return'),
    'a fix that never returned is named as such to the re-reviewer')

  r = await run({ review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
  check(modelOf(r.dispatches, 'rereview:412') === null
    && !r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('Review scope: LIGHT')
    && r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('full-scope'),
  'a light review that blocks escalates the re-review to a full one on the session model')

  r = await run({ argv: '412 --small', review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
  check(modelOf(r.dispatches, 'fix:412') === null, 'a sonnet implementation that fails review escalates the fix')

  r = await run({ review: { ...CLEAN_REVIEW, findings: [{ ...BLOCKING_REVIEW.findings[0] }] } })
  check(r.phases.includes('Fix') && pr0(r).fix, 'a blocking finding under blocking=false still triggers the fix')

  r = await run({ review: null })
  check(pr0(r).reviewCompleted === false && r.result.reviewCompleted === false && !r.phases.includes('Fix'),
    'a review that never returned marks the run unreviewed')

  r = await run({ implement: null })
  check(r.result.reviewCompleted === false && !r.dispatches.some((d) => d.label?.startsWith('review:')),
    'an implementer that never returned marks the run unreviewed')

  // --- batches
  r = await run({ argv: '412 413 415' })
  check(r.dispatches.filter((d) => d.label?.startsWith('implement:')).length === 1
    && ['review:412', 'review:413', 'review:415'].every((l) => r.dispatches.some((d) => d.label === l))
    && r.result.batches[0].prs.length === 3,
  'a batch is one implementer and one review per PR')
  check(r.dispatches.every((d) => !d.isolation), 'a single batch runs in the caller checkout (no worktree)')
  check(r.dispatches[0].prompt.includes('never combine two issues in one PR'), 'a batch is told one PR per issue')

  r = await run({ argv: '412 413 415', implement: { issues: [412, 413].map((n) => ({ issue: n, pr: n + 1000, ...MEDIUM_ISSUE, report: 'x' })) } })
  check(r.result.reviewCompleted === false && JSON.stringify(r.result.batches[0].notImplemented) === '[415]'
    && r.logs.some((l) => l.startsWith('#415:')),
  'an issue the implementer did not report is named and the run is not reviewed')

  r = await run({ implement: { issues: [{ issue: 412, pr: null, ...MEDIUM_ISSUE, report: 'blocked' }] } })
  check(r.result.reviewCompleted === false && !r.dispatches.some((d) => d.label?.startsWith('review:')),
    'an issue with no PR is reported as unreviewed')

  r = await run({ argv: '412 413 ; 500 501 --small', review: BLOCKING_REVIEW })
  const impls = r.dispatches.filter((d) => d.label?.startsWith('implement:'))
  check(impls.length === 2 && r.result.batches.length === 2, 'two ;-separated batches get one implementer each')
  check(r.dispatches.every((d) => d.isolation === 'worktree'), 'concurrent batches put every agent in its own worktree')
  check(r.dispatches.every((d) => d.prompt.includes('own git worktree')), 'every isolated agent is told how to share branches')
  check(modelOf(r.dispatches, 'implement:412+413') === null && modelOf(r.dispatches, 'implement:500+501') === 'sonnet',
    'size hints apply to their own batch')
  check(r.result.batches.every((b) => b.prs.every((p) => p.reReview)), 'every PR in every batch gets its review cycles')

  r = await run({ argv: '412, 413' })
  check(r.dispatches.some((d) => d.label === 'implement:412+413'), 'comma-separated issues are a batch')

  r = await run({ argv: '412 ; 412' })
  check(r.dispatches.filter((d) => d.label?.startsWith('implement:')).length === 1, 'an issue listed twice is worked once')

  r = await run({ argv: 'fix the export, then the filter --small' })
  check(r.dispatches[0].prompt.includes('this request: fix the export, then the filter end to end')
    && modelOf(r.dispatches, 'implement:task') === 'sonnet',
  'a description keeps its punctuation and loses only the hint flag')

  r = await run({ argv: 'fix the export; then the filter' })
  check(r.result.batches.length === 1 && r.result.batches[0].issues.length === 0 && r.dispatches.every((d) => !d.isolation),
    'a description containing ; is one request, not batches')
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
