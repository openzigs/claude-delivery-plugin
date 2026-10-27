#!/usr/bin/env node
//
// Compare model tiers on the review eval suite under evals/. Stdlib only, read-only.
//
//   node scripts/eval-run.mjs                      # runs the matrix and calls this script
//   node scripts/eval-tiers.mjs <result.json>... [--json]
//
// Input: `claude plugin eval` result documents (schemaVersion 1), one per tier and scope, as
// scripts/eval-run.mjs writes them. The tier is the run's --model; the scope is LIGHT for a case
// named `<case>`, FULL for `<case>-full`, and BATCH for the batch-review comparison cases.
//
// Every case dispatches the delivery:code-review agent (scripts/eval-build.mjs). A run whose
// `review-agent-dispatched` grader did not pass reviewed nothing with the plugin's procedure: it
// is INVALID, counts as neither a hit nor a miss, and makes this script exit 1.
//
// Per tier and scope, over N runs of the suite (run i of every case is suite pass i):
//   recall        share of seeded-* cases whose found-seeded-defect grader passed, as the mean
//                 over passes with the min and max pass, overall and per category (the case's
//                 category tag: security, correctness, performance, tests, requirements)
//   false blocks  share of clean-* cases (decoys included) whose no-false-block grader failed,
//                 mean and range
//   cost          list-price cost of one pass of the suite, mean and range (costUsd per run)
//   turns         per run: the dispatching session's turns plus the reviewer's own turns, read
//                 from the run's trace (distinct assistant messages under the Agent call); mean
//                 and range
// Two tiers in one scope whose recall ranges overlap are "not distinguishable at N=<n>".
//
// Every control-* case seeds a defect no reviewer can see, so it must score 0. If one passes in
// any valid run, the grader cannot fail, the recall beside it means nothing, and this script says
// so and exits 1.
//
// Batch review (#66): batch-three-prs reviews three PRs in one --batch-review dispatch and
// per-pr-three-prs reviews the same three in one dispatch each. For each, recall over the two
// seeded PRs (found-<pr> graders) and false blocks on the clean one (no-false-block-<pr>). The
// graduation criterion for dropping "experimental" is printed with its verdict.
//
// Confidence calibration (#65): each finding line in a run's reply
// (`file:line — severity — confidence — blocking|non-blocking — finding`) is classed as the
// seeded defect (it matches the case's found grader's defect part), a decoy (it matches a decoy
// case's avoids-decoy pattern), on a clean change (any other finding on a clean case) or other,
// and the table counts how many in each class fall under a confidence of 30, 50 and 70.
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CATEGORIES = ['security', 'correctness', 'performance', 'tests', 'requirements']
export const THRESHOLDS = [30, 50, 70]
export const BATCH_CASES = { 'batch-three-prs': 'batch', 'per-pr-three-prs': 'per-pr' }
const DISPATCH = 'review-agent-dispatched'
const EVALS = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals')

// Case name -> its tags, from the `tags:` line of each case.yaml under evals/.
export function loadTags(dir = EVALS) {
  const out = {}
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const y = join(dir, e.name, 'case.yaml')
    if (!e.isDirectory() || !existsSync(y)) continue
    out[e.name] = (/^tags:\s*\[([^\]]*)\]/m.exec(readFileSync(y, 'utf8'))?.[1] || '').split(',').map((t) => t.trim()).filter(Boolean)
  }
  return out
}
// Case name -> category, for the seeded cases.
export function loadCategories(dir = EVALS) {
  const out = {}
  for (const [n, tags] of Object.entries(loadTags(dir))) {
    const cat = tags.find((t) => CATEGORIES.includes(t))
    if (cat) out[n] = cat
  }
  return out
}

const base = (c) => String(c.name).replace(/-full$/, '')
const scopeOf = (c) => (BATCH_CASES[base(c)] ? 'batch' : String(c.name).endsWith('-full') ? 'full' : 'light')
const runsOf = (c) => (Array.isArray(c?.arms?.with) ? c.arms.with : [])
const graderPassed = (run, name) => {
  const g = (run?.graders || []).find((x) => x.name === name)
  return g ? Boolean(g.passed) : null
}
export const isValid = (run) => graderPassed(run, DISPATCH) === true

export function stats(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (!v.length) return null
  return { mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v), n: v.length }
}

// The reviewer's turns in one run, from its trace: distinct assistant messages inside an Agent
// call (stream-json splits one turn's content blocks into several lines with the same id).
export function traceFacts(path) {
  if (!path || !existsSync(path)) return null
  let reviewerTurns = 0
  let reply = null
  const seen = new Set()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.type === 'assistant' && m.parent_tool_use_id) {
      const id = m.message?.id || `${m.uuid}`
      if (!seen.has(id)) { seen.add(id); reviewerTurns++ }
    }
    if (m.type === 'result' && typeof m.result === 'string') reply = m.result
  }
  return { reviewerTurns, reply }
}

const tracePathOf = (run, docDir) => {
  const p = run?.tracePath
  if (!p) return null
  return isAbsolute(p) ? p : join(docDir || '.', p)
}

export function summarise(doc, id, categories = loadCategories(), docDir = null) {
  const cases = Array.isArray(doc?.cases) ? doc.cases : null
  if (!cases || doc.schemaVersion !== 1) return null
  const scopes = [...new Set(cases.filter((c) => scopeOf(c) !== 'batch').map(scopeOf))].sort()
  const tier = doc.suite?.modelOverride || 'session model'
  return scopes.map((scope) => {
    const mine = cases.filter((c) => scopeOf(c) === scope)
    const seeded = mine.filter((c) => base(c).startsWith('seeded-'))
    const controls = mine.filter((c) => base(c).startsWith('control-'))
    const clean = mine.filter((c) => base(c).startsWith('clean-'))
    const passes = Math.max(0, ...mine.map((c) => runsOf(c).length))
    const invalid = mine.flatMap((c) => runsOf(c).map((r, i) => (isValid(r) ? null : `${c.name}#${i + 1}`))).filter(Boolean)
    const rate = (list, hit, i) => {
      const valid = list.filter((c) => runsOf(c)[i] && isValid(runsOf(c)[i]))
      return valid.length ? valid.filter((c) => hit(runsOf(c)[i])).length / valid.length : null
    }
    const found = (r) => graderPassed(r, 'found-seeded-defect') === true
    const blocked = (r) => graderPassed(r, 'no-false-block') !== true
    const perPass = (fn) => Array.from({ length: passes }, (_, i) => fn(i))
    const byCategory = {}
    for (const k of [...CATEGORIES, 'uncategorised']) {
      const inK = seeded.filter((c) => (categories[base(c)] || 'uncategorised') === k)
      if (inK.length) byCategory[k] = { seeded: inK.length, ...stats(perPass((i) => rate(inK, found, i))) }
    }
    const runs = mine.flatMap(runsOf)
    const facts = runs.map((r) => (isValid(r) ? traceFacts(tracePathOf(r, docDir)) : null))
    const turns = runs.map((r, i) => (isValid(r) && facts[i] ? (Number(r.turns) || 0) + facts[i].reviewerTurns : null))
    const passCost = perPass((i) => {
      const rs = mine.map((c) => runsOf(c)[i]).filter(Boolean)
      return rs.length && rs.every((r) => typeof r.costUsd === 'number') ? rs.reduce((n, r) => n + r.costUsd, 0) : null
    })
    const totalCost = runs.every((r) => typeof r?.costUsd === 'number') ? runs.reduce((n, r) => n + r.costUsd, 0) : null
    return {
      id,
      tier,
      scope,
      passes,
      seeded: seeded.length,
      recall: stats(perPass((i) => rate(seeded, found, i))),
      byCategory,
      clean: clean.length,
      falseBlock: stats(perPass((i) => rate(clean, blocked, i))),
      falseBlocked: clean.filter((c) => runsOf(c).some((r) => isValid(r) && blocked(r))).map((c) => c.name),
      missed: seeded.filter((c) => runsOf(c).some((r) => isValid(r) && !found(r))).map((c) => c.name),
      controls: controls.length,
      controlsFailedAsExpected: controls.every((c) => runsOf(c).every((r) => !isValid(r) || graderPassed(r, 'found-seeded-defect') !== true)),
      invalid,
      cost: stats(passCost),
      costUsd: totalCost,
      turns: stats(turns),
      tracesRead: facts.filter(Boolean).length,
      partial: Boolean(doc.partial),
    }
  })
}

// The batch-review comparison in one result document, if it holds either batch case.
export function summariseBatch(doc, id) {
  const cases = Array.isArray(doc?.cases) ? doc.cases : []
  const tier = doc.suite?.modelOverride || 'session model'
  const out = []
  for (const c of cases.filter((x) => BATCH_CASES[x.name])) {
    const names = (c.graders || []).map((g) => g.name)
    const seededG = names.filter((n) => /^found-\d+$/.test(n))
    const cleanG = names.filter((n) => /^no-false-block-\d+$/.test(n))
    const runs = runsOf(c)
    const valid = runs.filter(isValid)
    out.push({
      id,
      tier,
      mode: BATCH_CASES[c.name],
      runs: runs.length,
      invalid: runs.length - valid.length,
      seededPrs: seededG.length,
      recall: stats(valid.map((r) => seededG.filter((g) => graderPassed(r, g) === true).length / (seededG.length || 1))),
      falseBlocks: stats(valid.map((r) => cleanG.filter((g) => graderPassed(r, g) !== true).length)),
      cost: stats(runs.map((r) => r.costUsd)),
    })
  }
  return out
}

// The graduation criterion for --batch-review, from #92: at N >= 3 per mode, the batch review's
// mean recall is at least the per-PR review's lowest run, and it false-blocks no more often.
export function batchVerdict(batch, perPr) {
  if (!batch || !perPr || !batch.recall || !perPr.recall) return { met: false, why: 'missing one of the two modes' }
  if (batch.runs - batch.invalid < 3 || perPr.runs - perPr.invalid < 3) return { met: false, why: 'fewer than 3 valid runs in a mode' }
  const recallOk = batch.recall.mean >= perPr.recall.min
  const fbOk = (batch.falseBlocks?.mean ?? 0) <= (perPr.falseBlocks?.mean ?? 0)
  return {
    met: recallOk && fbOk,
    why: [
      `batch mean recall ${pct(batch.recall.mean)} ${recallOk ? '>=' : '<'} per-PR min ${pct(perPr.recall.min)}`,
      `batch false blocks ${num(batch.falseBlocks?.mean)} ${fbOk ? '<=' : '>'} per-PR ${num(perPr.falseBlocks?.mean)}`,
    ].join('; '),
  }
}

// The defect part of a found grader's pattern: the pattern without its verdict tail (and, for a
// batch grader, without its section prefix), so it can be matched against one finding line.
export function findingPattern(pattern) {
  const section = '(?:(?!## PR #)[\\s\\S])*?'
  let p = String(pattern)
  const m = /^## PR #\d+\\b/.exec(p)
  if (m && p.startsWith(section, m[0].length)) p = p.slice(m[0].length + section.length)
  for (const tail of ['[\\s\\S]*Recommendation:', `${section}Recommendation:`]) {
    const at = p.lastIndexOf(tail)
    if (at > 0) return p.slice(0, at)
  }
  return p
}

const FINDING = /^\s*[-*]?\s*(.+?)\s+[—–-]{1,2}\s+(critical|high|medium|low|nit)\s+[—–-]{1,2}\s+(\d{1,3})\s+[—–-]{1,2}\s+(blocking|non-blocking)\s+[—–-]{1,2}\s+(.+)$/i
export function parseFindings(reply) {
  const out = []
  let pr = null
  for (const line of String(reply || '').split('\n')) {
    const h = /^##\s+PR\s+#(\d+)/.exec(line)
    if (h) { pr = Number(h[1]); continue }
    const m = FINDING.exec(line.replace(/\*\*/g, ''))
    if (m) out.push({ pr, line, location: m[1], severity: m[2].toLowerCase(), confidence: Number(m[3]), blocking: m[4].toLowerCase() === 'blocking', summary: m[5] })
  }
  return out
}

// Class every finding in every valid run: seeded, decoy, clean or other.
export function calibrate(docs, tags = loadTags()) {
  const findings = []
  for (const { doc, dir } of docs) {
    for (const c of doc?.cases || []) {
      const n = base(c)
      const defs = Object.fromEntries((c.graders || []).filter((g) => g.type === 'regex').map((g) => [g.name, g.config || {}]))
      const re = (g) => (g && g.pattern ? new RegExp(findingPattern(g.pattern), (g.flags || '').replace('g', '')) : null)
      const isDecoy = (tags[n] || []).includes('decoy')
      for (const r of runsOf(c)) {
        if (!isValid(r)) continue
        const f = traceFacts(tracePathOf(r, dir))
        if (!f?.reply) continue
        for (const x of parseFindings(f.reply)) {
          let cls = 'other'
          if (BATCH_CASES[n]) {
            const found = re(defs[`found-${x.pr}`])
            if (found && found.test(x.line)) cls = 'seeded'
            else if (defs[`no-false-block-${x.pr}`]) cls = 'clean'
          } else if (n.startsWith('seeded-')) {
            const found = re(defs['found-seeded-defect'])
            if (found && found.test(x.line)) cls = 'seeded'
          } else if (n.startsWith('clean-')) {
            const lure = re(defs['avoids-decoy'])
            cls = isDecoy && lure && lure.test(x.line) ? 'decoy' : 'clean'
          }
          findings.push({ case: c.name, cls, confidence: x.confidence, blocking: x.blocking, severity: x.severity })
        }
      }
    }
  }
  const table = {}
  for (const cls of ['seeded', 'decoy', 'clean', 'other']) {
    const mine = findings.filter((f) => f.cls === cls)
    table[cls] = {
      findings: mine.length,
      blocking: mine.filter((f) => f.blocking).length,
      // CONFIDENCE_THRESHOLD in workflows/orchestrate.js drops only non-blocking findings below it.
      dropped: Object.fromEntries(THRESHOLDS.map((t) => [t, mine.filter((f) => !f.blocking && f.confidence < t).length])),
      below: Object.fromEntries(THRESHOLDS.map((t) => [t, mine.filter((f) => f.confidence < t).length])),
    }
  }
  // The highest threshold that would drop no seeded-defect finding, and what it would drop.
  const safe = [...THRESHOLDS].reverse().find((t) => table.seeded.dropped[t] === 0) ?? null
  return { findings, table, safest: safe }
}

// Tiers in the same scope whose recall ranges overlap cannot be told apart at this N.
export function overlaps(rows) {
  const out = []
  for (const scope of [...new Set(rows.map((r) => r.scope))]) {
    const rs = rows.filter((r) => r.scope === scope && r.recall)
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const a = rs[i], b = rs[j]
        if (a.tier === b.tier) continue
        const overlap = a.recall.min <= b.recall.max && b.recall.min <= a.recall.max
        const n = Math.min(a.passes, b.passes)
        out.push({ scope, a: a.tier, b: b.tier, overlap,
          note: overlap
            ? `${a.tier} and ${b.tier} (${scope}): recall ranges overlap, not distinguishable at N=${n}`
            : `${a.tier} and ${b.tier} (${scope}): recall ranges do not overlap at N=${n}` })
      }
    }
  }
  return out
}

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`)
const num = (x, d = 1) => (x == null ? 'n/a' : Number(x).toFixed(d))
const range = (s, f = pct) => (s ? `${f(s.mean)} [${f(s.min)}-${f(s.max)}]` : 'n/a')
const usd = (x) => (x == null ? 'n/a' : `$${x.toFixed(4)}`)

export function render(rows, batch, cal) {
  const lines = []
  const cat = (r, k) => (r.byCategory[k] ? `${range(r.byCategory[k])} of ${r.byCategory[k].seeded}` : '-')
  const head = ['tier', 'scope', 'N', 'recall mean [min-max]', ...CATEGORIES, 'false blocks', 'control', 'cost/pass', 'turns/run', 'invalid', 'note']
  const fmt = (r) => [r.tier, r.scope, String(r.passes), `${range(r.recall)} of ${r.seeded}`, ...CATEGORIES.map((k) => cat(r, k)),
    `${range(r.falseBlock)} of ${r.clean}`, r.controlsFailedAsExpected ? `ok (${r.controls} scored 0)` : 'SCORER CANNOT FAIL',
    range(r.cost, usd), range(r.turns, (x) => num(x)), r.invalid.length ? `${r.invalid.length} INVALID` : '0', r.partial ? 'PARTIAL' : '']
  const table = [head, ...rows.map(fmt)]
  const w = head.map((_, i) => Math.max(...table.map((t) => String(t[i]).length)))
  if (rows.length) for (const t of table) lines.push(t.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd())
  for (const o of overlaps(rows)) lines.push(o.note)
  for (const r of rows.filter((x) => x.invalid.length)) {
    lines.push(`INVALID: ${r.tier} ${r.scope}: ${r.invalid.join(', ')} did not dispatch the delivery:code-review agent, so the review procedure never ran. Not counted.`)
  }
  for (const r of rows.filter((x) => x.missed.length)) lines.push(`missed (${r.tier} ${r.scope}, in at least one run): ${r.missed.join(', ')}`)
  for (const r of rows.filter((x) => x.falseBlocked.length)) lines.push(`false-blocked (${r.tier} ${r.scope}, in at least one run): ${r.falseBlocked.join(', ')}`)
  if (rows.some((r) => !r.tracesRead && r.passes)) lines.push('turns/run is n/a where no trace was kept: run the suite through scripts/eval-run.mjs, which keeps them.')
  if (batch.length) {
    if (lines.length) lines.push('')
    lines.push('Batch review (#66): two seeded PRs and one clean PR, as one --batch-review dispatch or three per-PR dispatches')
    const bh = ['tier', 'mode', 'runs', 'recall mean [min-max]', 'false blocks/run', 'cost/run', 'invalid']
    const bt = [bh, ...batch.map((b) => [b.tier, b.mode, String(b.runs), `${range(b.recall)} of ${b.seededPrs}`, range(b.falseBlocks, (x) => num(x)), range(b.cost, usd), String(b.invalid)])]
    const bw = bh.map((_, i) => Math.max(...bt.map((t) => String(t[i]).length)))
    for (const t of bt) lines.push(t.map((c, i) => String(c).padEnd(bw[i])).join('  ').trimEnd())
    for (const tier of [...new Set(batch.map((b) => b.tier))]) {
      const v = batchVerdict(batch.find((b) => b.tier === tier && b.mode === 'batch'), batch.find((b) => b.tier === tier && b.mode === 'per-pr'))
      lines.push(`--batch-review graduation criterion (${tier}): ${v.met ? 'MET' : 'NOT MET'} — ${v.why}`)
    }
  }
  if (cal && cal.findings.length) {
    lines.push('', `Confidence calibration (#65): ${cal.findings.length} findings from valid runs. "dropped" = non-blocking and below the threshold (what CONFIDENCE_THRESHOLD removes); "below" counts blocking ones too.`)
    const ch = ['finding is', 'count', 'blocking', ...THRESHOLDS.map((t) => `dropped <${t}`), ...THRESHOLDS.map((t) => `below <${t}`)]
    const ct = [ch, ...Object.entries(cal.table).map(([k, v]) => [k, String(v.findings), String(v.blocking), ...THRESHOLDS.map((t) => String(v.dropped[t])), ...THRESHOLDS.map((t) => String(v.below[t]))])]
    const cw = ch.map((_, i) => Math.max(...ct.map((t) => String(t[i]).length)))
    for (const t of ct) lines.push(t.map((c, i) => String(c).padEnd(cw[i])).join('  ').trimEnd())
    lines.push(cal.safest == null
      ? 'Every threshold tested would drop at least one seeded-defect finding.'
      : `The highest tested threshold that drops no seeded-defect finding is ${cal.safest}; it drops ${cal.table.decoy.dropped[cal.safest] + cal.table.clean.dropped[cal.safest]} decoy or clean-change finding(s) and ${cal.table.other.dropped[cal.safest]} other(s).`)
  }
  lines.push('Recall and false blocks are means over N passes of the suite, with the lowest and highest pass. costUsd is list price.')
  lines.push('Effort was not compared: claude plugin eval has no effort flag, so every row ran at the CLI default effort.')
  return lines.join('\n')
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const paths = args.filter((a) => a !== '--json')
  if (!paths.length) {
    console.log('usage: node scripts/eval-tiers.mjs <result.json>... [--json]')
    process.exit(2)
  }
  const rows = []
  const batch = []
  const docs = []
  let status = 0
  const categories = loadCategories()
  for (const p of paths) {
    let doc
    try { doc = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { console.error(`cannot read ${p}: ${e.message}`); status = 1; continue }
    const got = summarise(doc, basename(p), categories, dirname(resolve(p)))
    if (!got) { console.error(`${p}: not a claude plugin eval result (schemaVersion 1)`); status = 1; continue }
    if (got.some((r) => !r.controlsFailedAsExpected || r.invalid.length)) status = 1
    rows.push(...got)
    const b = summariseBatch(doc, basename(p))
    if (b.some((x) => x.invalid)) status = 1
    batch.push(...b)
    docs.push({ doc, dir: dirname(resolve(p)) })
  }
  const cal = calibrate(docs)
  if (asJson) console.log(JSON.stringify({ rows, batch, overlaps: overlaps(rows), calibration: { table: cal.table, safest: cal.safest } }, null, 2))
  else console.log(render(rows, batch, cal))
  process.exit(status)
}
