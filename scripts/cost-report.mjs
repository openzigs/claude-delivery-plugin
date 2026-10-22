#!/usr/bin/env node
//
// Per-run, per-phase cost report over saved /delivery:orchestrate and
// /delivery:plan-epic results. Stdlib only, read-only: it opens its inputs for
// reading and writes only to stdout and stderr.
//
//   node scripts/cost-report.mjs [--json] [--include-concurrent] <result.json | dir>...
//     dir: every *.json directly inside it, sorted by file name (= run order)
//
// Cell values, in the table and in --json:
//   a number  measured output tokens
//   null      "not measured": the field is there but the runtime gave no budget
//   'n/a'     the workflow never records this field for this phase
//
// The arithmetic lives here so that no model ever sums the numbers.
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CAVEAT =
  'Caveat: severity counts are a proxy and do not show whether findings were lost ' +
  '(Cloudflare, "Obsessive inference optimization", 2026-10-19).'

const NA = 'n/a'
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit']
const ORCHESTRATE_PHASES = [['Review', 'review'], ['Fix', 'fix'], ['Re-review', 'rereview']]

// A present-but-null field is "not measured" (null); an absent one is n/a.
const cell = (obj, key, ok) => {
  if (obj === null || typeof obj !== 'object' || !(key in obj)) return NA
  const v = obj[key]
  return v === null || ok(v) ? v : NA
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr = (v) => typeof v === 'string'
const isCounts = (v) => v !== null && typeof v === 'object' && SEVERITIES.every((s) => isNum(v[s]))

function workflowOf(data) {
  if (data === null || typeof data !== 'object') return null
  if (Array.isArray(data.batches)) return 'orchestrate'
  if (data.outputTokens && typeof data.outputTokens === 'object' && 'research' in data.outputTokens) return 'plan-epic'
  return null
}

function orchestrateRows(data) {
  const rows = []
  data.batches.forEach((b, i) => {
    const batch = i + 1
    const prs = Array.isArray(b?.prs) ? b.prs : []
    const issues = Array.isArray(b?.issues) ? b.issues : []
    rows.push({
      batch, issue: issues.length ? issues : NA, pr: NA, phase: 'Implement',
      outputTokens: cell(b?.outputTokens, 'implement', isNum),
      effort: prs.length ? cell(prs[0]?.effort, 'implement', isStr) : NA,
      model: cell(b, 'implementModel', isStr),
      findings: NA, reviewDidNotReturn: false,
    })
    for (const p of prs) {
      const notReturned = p?.reviewCompleted === false
      for (const [phase, key] of ORCHESTRATE_PHASES) {
        // Review always ran for a PR entry; fix and re-review only when recorded.
        const ran = key === 'review' || [p?.outputTokens, p?.effort, p?.models].some((o) => o && typeof o === 'object' && key in o)
        if (!ran) continue
        const findings = key === 'fix' || notReturned ? NA : cell(p?.findingCounts, key, isCounts)
        rows.push({
          batch, issue: cell(p, 'issue', isNum), pr: cell(p, 'pr', isNum), phase,
          outputTokens: cell(p?.outputTokens, key, isNum),
          effort: cell(p?.effort, key, isStr),
          model: cell(p?.models, key, isStr),
          findings,
          reviewDidNotReturn: notReturned && key === 'review',
        })
      }
    }
  })
  return rows
}

function planEpicRows(data) {
  return [['Research', 'research'], ['Plan', 'plan']].map(([phase, key]) => ({
    phase, outputTokens: cell(data.outputTokens, key, isNum), effort: NA, model: NA, findings: NA, reviewDidNotReturn: false,
  }))
}

// Adds only measured numbers; a null is counted as unmeasured, an n/a is neither.
function sumTokens(rows) {
  let sum = 0, measured = 0, unmeasured = 0
  for (const r of rows) {
    if (isNum(r.outputTokens)) { sum += r.outputTokens; measured++ } else if (r.outputTokens === null) unmeasured++
  }
  return { outputTokens: measured ? sum : null, unmeasured }
}

export function summarise(results, opts = {}) {
  const includeConcurrent = Boolean(opts.includeConcurrent)
  const runs = [], unrecognised = []
  for (const { id, data } of results) {
    const workflow = workflowOf(data)
    if (!workflow) { unrecognised.push(id); continue }
    const rows = workflow === 'orchestrate' ? orchestrateRows(data) : planEpicRows(data)
    const concurrent = workflow === 'orchestrate' && data.batches.length > 1
    runs.push({ id, workflow, concurrent, rows, total: sumTokens(rows) })
  }

  const zero = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]))
  const findingCounts = { review: zero(), rereview: zero() }
  const reviewsCounted = { review: 0, rereview: 0 }
  let reviewsNotReturned = 0
  for (const run of runs) {
    for (const r of run.rows) {
      if (r.reviewDidNotReturn) { reviewsNotReturned++; continue }
      const key = r.phase === 'Review' ? 'review' : r.phase === 'Re-review' ? 'rereview' : null
      if (!key || !isCounts(r.findings)) continue
      reviewsCounted[key]++
      for (const s of SEVERITIES) findingCounts[key][s] += r.findings[s]
    }
  }

  // Token deltas of a concurrent run include the other batches' spend, so they
  // stay out of the cross-run comparison unless asked for.
  const phases = {}, excluded = []
  for (const run of runs) {
    if (run.concurrent && !includeConcurrent) { excluded.push(run.id); continue }
    const byPhase = new Map()
    for (const r of run.rows) {
      if (r.outputTokens === NA) continue
      byPhase.set(r.phase, [...(byPhase.get(r.phase) || []), r])
    }
    for (const [phase, rows] of byPhase) {
      ;(phases[phase] ||= []).push({ run: run.id, outputTokens: sumTokens(rows).outputTokens })
    }
  }

  return {
    runs,
    unrecognised,
    totals: {
      ...sumTokens(runs.flatMap((r) => r.rows)),
      concurrentRuns: runs.filter((r) => r.concurrent).length,
      findingCounts,
      reviewsCounted,
      reviewsNotReturned,
    },
    trend: { includeConcurrent, excluded, phases },
    caveat: CAVEAT,
  }
}

// ------------------------------------------------------------------ rendering

const fmtNum = (v) => (v === null ? 'not measured' : v === NA ? NA : v.toLocaleString('en-US'))
const fmtCounts = (c) => SEVERITIES.map((s) => `${s[0]}${c[s]}`).join(' ')
const fmtCell = (v) => (v === null ? 'not measured' : v === NA ? NA : isCounts(v) ? fmtCounts(v) : String(v))
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
// Nothing recorded at all is n/a; something recorded but all null is not measured.
const fmtTotal = ({ outputTokens, unmeasured }) =>
  outputTokens === null && !unmeasured ? NA
    : `${fmtNum(outputTokens)}${unmeasured ? ` (${plural(unmeasured, 'phase')} not measured)` : ''}`

function table(head, body) {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)))
  return [head, ...body].map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()).join('\n')
}

export function render(report) {
  const out = []
  for (const run of report.runs) {
    out.push(`== ${run.id} (${run.workflow}) ==`)
    if (run.concurrent) {
      const n = new Set(run.rows.map((r) => r.batch)).size
      out.push(`CONCURRENT (${n} batches): token deltas include the other batches' spend`)
    }
    if (run.workflow === 'orchestrate') {
      const ref = (v, p) => (v === NA ? '-' : Array.isArray(v) ? v.map((n) => `${p}${n}`).join(',') : v === null ? '-' : `${p}${v}`)
      out.push(table(['batch', 'issue', 'pr', 'phase', 'outputTokens', 'effort', 'model', 'findings', 'note'],
        run.rows.map((r) => [String(r.batch), ref(r.issue, '#'), ref(r.pr, '#'), r.phase, fmtNum(r.outputTokens),
          fmtCell(r.effort), fmtCell(r.model), fmtCell(r.findings), r.reviewDidNotReturn ? 'REVIEW DID NOT RETURN' : ''])))
    } else {
      out.push(table(['phase', 'outputTokens', 'effort', 'model', 'findings'],
        run.rows.map((r) => [r.phase, fmtNum(r.outputTokens), fmtCell(r.effort), fmtCell(r.model), fmtCell(r.findings)])))
    }
    out.push(`total ${fmtTotal(run.total)}`, '')
  }
  for (const id of report.unrecognised) out.push(`unrecognised: ${id}`)
  if (report.unrecognised.length) out.push('')

  const t = report.totals
  out.push('Totals (all recognised runs)')
  out.push(`  outputTokens ${fmtTotal(t)}` +
    (t.concurrentRuns ? `; includes ${plural(t.concurrentRuns, 'concurrent run')}, whose deltas overlap` : ''))
  out.push(`  findings review   ${fmtCounts(t.findingCounts.review)} over ${plural(t.reviewsCounted.review, 'review')}` +
    (t.reviewsNotReturned ? ` (${plural(t.reviewsNotReturned, 'review')} did not return, not counted)` : ''))
  out.push(`  findings rereview ${fmtCounts(t.findingCounts.rereview)} over ${plural(t.reviewsCounted.rereview, 're-review')}`, '')

  const tr = report.trend
  out.push('Per-phase trend (run order' +
    (tr.excluded.length ? `; ${plural(tr.excluded.length, 'concurrent run')} excluded, --include-concurrent to add` : '') +
    (tr.includeConcurrent ? '; concurrent runs included' : '') + ')')
  const entries = Object.entries(tr.phases)
  if (!entries.length) out.push('  (no runs)')
  const w = Math.max(0, ...entries.map(([p]) => p.length))
  for (const [phase, list] of entries) {
    out.push(`  ${phase.padEnd(w)}  ${list.map((e) => `${e.run} ${fmtNum(e.outputTokens)}`).join(' -> ')}`)
  }
  out.push('', report.caveat)
  return out.join('\n') + '\n'
}

// ------------------------------------------------------------------------ CLI

const USAGE = 'usage: node scripts/cost-report.mjs [--json] [--include-concurrent] <result.json | dir>...'

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const paths = argv.filter((a) => !a.startsWith('--'))
  const unknown = [...flags].filter((f) => f !== '--json' && f !== '--include-concurrent')
  if (unknown.length || !paths.length) {
    process.stderr.write(`${unknown.length ? `unknown option ${unknown.join(', ')}\n` : ''}${USAGE}\n`)
    return 2
  }

  let status = 0
  const results = []
  const load = (file) => {
    let text
    try { text = readFileSync(file, 'utf8') } catch (e) {
      process.stderr.write(`cannot read ${file}: ${e.message}\n`); status = 1; return
    }
    let data = null
    try { data = JSON.parse(text) } catch { process.stderr.write(`${file}: not valid JSON\n`) }
    results.push({ id: basename(file), data })
  }
  for (const p of paths) {
    let st
    try { st = statSync(p) } catch (e) { process.stderr.write(`cannot read ${p}: ${e.message}\n`); status = 1; continue }
    if (!st.isDirectory()) { load(p); continue }
    let names
    try { names = readdirSync(p).filter((f) => f.endsWith('.json')).sort() } catch (e) {
      process.stderr.write(`cannot read ${p}: ${e.message}\n`); status = 1; continue
    }
    for (const f of names) {
      const full = join(p, f)
      let isFile
      try { isFile = statSync(full).isFile() } catch (e) {
        process.stderr.write(`cannot read ${full}: ${e.message}\n`); status = 1; continue
      }
      if (isFile) load(full)
    }
  }

  const report = summarise(results, { includeConcurrent: flags.has('--include-concurrent') })
  process.stdout.write(flags.has('--json') ? `${JSON.stringify(report, null, 2)}\n` : render(report))
  return status
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
