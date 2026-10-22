#!/usr/bin/env node
//
// Per-run, per-phase cost report over saved /delivery:orchestrate and
// /delivery:plan-epic results. Stdlib only, read-only: it opens its inputs for
// reading and writes only to stdout and stderr.
//
//   node scripts/cost-report.mjs [--json] [--include-concurrent] [--verbose] <result.json | task.output | dir>...
//     dir: every *.json and *.output directly inside it, sorted by file name
//   node scripts/cost-report.mjs [--json] [--include-concurrent] [--verbose] --discover [--last N] [--since DATE]
//     the runs Claude Code persisted for the current directory's project:
//     <config>/projects/<slug of cwd>/<session>/workflows/wf_<run-id>.json, where
//     <config> is $CLAUDE_CONFIG_DIR or ~/.claude. That layout is undocumented
//     (checked on Claude Code 2.1.308) and may change; files that do not fit are skipped.
//
// A file is a bare result object, or a finished workflow's task output: a
// wrapper whose `result` is the result object or a JSON string of one. A
// wrapper's own runId / run_id / taskId / task_id, when present and matching
// SAFE_ID, is the run id; two inputs that would share one fall back to their
// path ids. A wrapper whose workflowName is not a delivery workflow is skipped.
//
// Runs are ordered by their startTime / timestamp (the wrapper's, else the
// result's) when every run has one, and otherwise kept in input order. Under
// --discover, input order is session-directory order, which says nothing about
// age, so runs with no start time are placed first (the oldest end) and the rest
// by start time: --last N then keeps the N newest timed runs. --since drops a run
// with no start time and counts it on the skipped line.
//
// Files found in a directory that are not JSON or not a delivery result are
// skipped and counted on one line; --verbose lists them. A file named on the
// command line that is neither is reported on a line of its own, as unrecognised.
//
// A run's id is its path relative to the deepest directory holding every input
// file, so a/result.json and b/result.json stay distinct; files that share one
// directory keep their bare file name. Inputs are resolved through symlinks
// first, so two spellings of one directory are one id. When the only common
// directory is /, each id is the shortest path suffix no other input shares.
//
// Cell values, in the table and in --json:
//   a number  measured output tokens
//   null      "not measured": the field is there but the runtime gave no budget
//   'n/a'     the workflow never records this field for this phase
//
// The arithmetic lives here so that no model ever sums the numbers.
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, dirname, basename, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
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

const WRAPPER_IDS = ['runId', 'run_id', 'taskId', 'task_id']
// A wrapper id is printed as a table heading, so it must not carry a newline or
// anything else that could forge a line of the report.
export const SAFE_ID = /^[\w.:-]{1,128}$/
export const DELIVERY_WORKFLOWS = new Set(['orchestrate', 'plan-epic', 'delivery:orchestrate', 'delivery:plan-epic'])
export const NOT_JSON = 'not JSON'
export const NOT_DELIVERY = 'not a delivery result'
export const NO_TIME = 'without a start time'

// startTime is epoch milliseconds in a persisted run; timestamp is an ISO string.
function timeOf(o) {
  if (o === null || typeof o !== 'object') return undefined
  for (const k of ['startTime', 'timestamp']) {
    const v = o[k]
    const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN
    if (Number.isFinite(t)) return t
  }
  return undefined
}

const withTime = (r, t) => (t === undefined ? r : { ...r, startTime: t })

// A bare result is returned as is; a wrapper around one yields the inner result,
// the wrapper's id and its start time. A wrapper that names a workflow other than
// a delivery one is marked skip. Anything else is returned unchanged, to be unrecognised.
export function unwrap(data) {
  if (workflowOf(data)) return withTime({ data }, timeOf(data))
  if (data === null || typeof data !== 'object' || !('result' in data)) return { data }
  if ('workflowName' in data && !DELIVERY_WORKFLOWS.has(data.workflowName)) return { data, skip: NOT_DELIVERY }
  let inner = data.result
  if (typeof inner === 'string') {
    try { inner = JSON.parse(inner) } catch { return { data } }
  }
  if (!workflowOf(inner)) return { data }
  const runId = WRAPPER_IDS.map((k) => data[k]).find((v) => typeof v === 'string' && SAFE_ID.test(v))
  return withTime(runId === undefined ? { data: inner } : { data: inner, runId }, timeOf(data) ?? timeOf(inner))
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
  const since = isNum(opts.since) ? opts.since : null
  const last = Number.isInteger(opts.last) && opts.last > 0 ? opts.last : null
  const untimedFirst = Boolean(opts.untimedFirst)
  const runs = [], unrecognised = [], skipped = [], times = []
  for (const { id, data, skip, fromDir, notJson, startTime } of results) {
    const workflow = skip ? null : workflowOf(data)
    if (!workflow) {
      if (skip || fromDir) skipped.push({ id, reason: skip || (notJson ? NOT_JSON : NOT_DELIVERY) })
      else unrecognised.push(id)
      continue
    }
    const rows = workflow === 'orchestrate' ? orchestrateRows(data) : planEpicRows(data)
    const concurrent = workflow === 'orchestrate' && data.batches.length > 1
    runs.push({ id, workflow, concurrent, rows, total: sumTokens(rows), ...(isNum(startTime) ? { startTime } : {}) })
    times.push(startTime)
  }
  // Start-time order only when every run has one; a partial order would be a
  // guess, unless untimedFirst puts the runs with none at the oldest end.
  const order = runs.length && (untimedFirst || times.every(isNum)) ? 'start time' : 'input'
  if (order === 'start time') {
    const key = (t) => (isNum(t) ? t : -Infinity)
    const byTime = runs.map((r, i) => [key(times[i]), i, r]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((e) => e[2])
    runs.splice(0, runs.length, ...byTime)
  }
  // --since keeps runs that started at or after it; a run with no start time
  // cannot be shown to have, and is counted as skipped. --last keeps the last N
  // in the order above.
  const found = runs.length
  if (since !== null) {
    for (const r of runs) if (!isNum(r.startTime)) skipped.push({ id: r.id, reason: NO_TIME })
    runs.splice(0, runs.length, ...runs.filter((r) => isNum(r.startTime) && r.startTime >= since))
  }
  if (last !== null) runs.splice(0, Math.max(0, runs.length - last))

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
    skipped,
    totals: {
      ...sumTokens(runs.flatMap((r) => r.rows)),
      concurrentRuns: runs.filter((r) => r.concurrent).length,
      findingCounts,
      reviewsCounted,
      reviewsNotReturned,
    },
    trend: { order, untimed: runs.filter((r) => !isNum(r.startTime)).length, includeConcurrent, excluded, phases },
    ...(since !== null || last !== null ? { filter: { found } } : {}),
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

export function render(report, opts = {}) {
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
  const sk = report.skipped || []
  if (sk.length) {
    const by = [NOT_JSON, NOT_DELIVERY, NO_TIME].map((why) => [why, sk.filter((s) => s.reason === why).length]).filter(([, n]) => n)
    out.push(`skipped ${plural(sk.length, 'file')} (${by.map(([why, n]) => `${n} ${why}`).join(', ')})` +
      (opts.verbose ? '' : '; --verbose lists them'))
    if (opts.verbose) for (const s of sk) out.push(`  skipped: ${s.id} (${s.reason})`)
  }
  if (report.unrecognised.length || sk.length) out.push('')

  const t = report.totals
  out.push('Totals (all recognised runs)')
  out.push(`  outputTokens ${fmtTotal(t)}` +
    (t.concurrentRuns ? `; includes ${plural(t.concurrentRuns, 'concurrent run')}, whose deltas overlap` : ''))
  out.push(`  findings review   ${fmtCounts(t.findingCounts.review)} over ${plural(t.reviewsCounted.review, 'review')}` +
    (t.reviewsNotReturned ? ` (${plural(t.reviewsNotReturned, 'review')} did not return, not counted)` : ''))
  out.push(`  findings rereview ${fmtCounts(t.findingCounts.rereview)} over ${plural(t.reviewsCounted.rereview, 're-review')}`, '')

  const tr = report.trend
  out.push(`Per-phase trend (${tr.order === 'start time' ? 'by start time' : 'in input order'}` +
    (tr.order === 'start time' && tr.untimed ? `; ${plural(tr.untimed, 'run')} without a start time placed first` : '') +
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

// The id of each run: the wrapper's own id when it has one, otherwise its path
// relative to the inputs' common directory. A wrapper id that another input also
// gets falls back to the path id, which is unique, so ids stay distinct.
export function runIds(results) {
  const paths = pathIds(results)
  const ids = results.map((r, i) => r.runId ?? paths[i])
  for (;;) {
    const count = new Map()
    for (const id of ids) count.set(id, (count.get(id) || 0) + 1)
    const clash = ids.map((id, i) => id !== paths[i] && count.get(id) > 1)
    if (!clash.some(Boolean)) break
    clash.forEach((c, i) => { if (c) ids[i] = paths[i] })
  }
  return results.map((r, i) => ({ ...r, id: ids[i] }))
}

function pathIds(results) {
  if (!results.length) return []
  const dirs = results.map((r) => dirname(r.file).split(sep))
  let n = dirs[0].length
  for (const d of dirs) {
    let i = 0
    while (i < n && i < d.length && d[i] === dirs[0][i]) i++
    n = i
  }
  const root = dirs[0].slice(0, n).join(sep)
  if (root) return results.map(({ file }) => relative(root, file))
  const parts = results.map((r) => r.file.split(sep).filter(Boolean))
  const tail = (p, k) => p.slice(-k).join(sep)
  return parts.map((p, i) => {
    let k = 1
    while (k < p.length && parts.some((q, j) => j !== i && tail(q, k) === tail(p, k))) k++
    return tail(p, k)
  })
}

// --------------------------------------------------------------- --discover

// Claude Code names a project's directory after its path, every character other
// than a letter or digit replaced by '-': /a/b.c_d -> -a-b-c-d.
export const projectSlug = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-')
export const RUN_FILE = /^wf_[\w-]+\.json$/
export const configDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

// The persisted run files for the project at cwd. Only <session>/workflows/wf_*.json
// is read: transcripts, journals and any other file beside them are never opened.
export function discoverFiles(config, cwd) {
  const root = join(config, 'projects', projectSlug(cwd))
  const files = []
  const dirs = (d) => { try { return readdirSync(d, { withFileTypes: true }) } catch { return [] } }
  for (const session of dirs(root).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const wf = join(root, session, 'workflows')
    for (const e of dirs(wf).filter((e) => RUN_FILE.test(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(wf, e.name)
      try { if (statSync(full).isFile()) files.push(full) } catch { /* vanished or dangling: not a run */ }
    }
  }
  return { root, files }
}

const USAGE = 'usage: node scripts/cost-report.mjs [--json] [--include-concurrent] [--verbose] <result.json | task.output | dir>...\n' +
  '       node scripts/cost-report.mjs [--json] [--include-concurrent] [--verbose] --discover [--last N] [--since DATE]'
export const FLAGS = new Set(['--json', '--include-concurrent', '--verbose', '--discover'])
export const VALUED = new Set(['--last', '--since'])

function main(argv) {
  const flags = new Set(), values = {}, paths = [], errors = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUED.has(a)) {
      if (i + 1 >= argv.length) errors.push(`${a} needs a value`)
      else values[a] = argv[++i]
    } else if (a.startsWith('--')) {
      if (FLAGS.has(a)) flags.add(a); else errors.push(`unknown option ${a}`)
    } else paths.push(a)
  }
  const discover = flags.has('--discover')
  let last, since
  if ('--last' in values) {
    last = /^[1-9]\d*$/.test(values['--last']) ? Number(values['--last']) : undefined
    if (last === undefined) errors.push(`--last needs a positive whole number, not ${JSON.stringify(values['--last'])}`)
  }
  if ('--since' in values) {
    since = Date.parse(values['--since'])
    if (!Number.isFinite(since)) errors.push(`--since needs a date such as 2026-10-01, not ${JSON.stringify(values['--since'])}`)
  }
  if (!discover && (last !== undefined || since !== undefined)) errors.push('--last and --since go with --discover')
  if (discover && paths.length) errors.push('--discover takes no paths')
  if (!discover && !paths.length && !errors.length) errors.push('no paths given')
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n${USAGE}\n`)
    return 2
  }

  let status = 0
  const results = []
  const load = (file, fromDir) => {
    let text
    try { text = readFileSync(file, 'utf8') } catch (e) {
      process.stderr.write(`cannot read ${file}: ${e.message}\n`); status = 1; return
    }
    let parsed = null, notJson = false
    try { parsed = JSON.parse(text) } catch {
      notJson = true
      if (!fromDir) process.stderr.write(`${file}: not valid JSON\n`)
    }
    // The directory, not the file, is resolved: a symlinked file keeps its own name.
    results.push({ file: join(realpathSync(dirname(resolve(file))), basename(file)), fromDir, notJson, ...unwrap(parsed) })
  }
  let found = null
  if (discover) {
    found = discoverFiles(configDir(), process.cwd())
    for (const f of found.files) load(f, true)
  }
  for (const p of paths) {
    let st
    try { st = statSync(p) } catch (e) { process.stderr.write(`cannot read ${p}: ${e.message}\n`); status = 1; continue }
    if (!st.isDirectory()) { load(p, false); continue }
    let names
    try { names = readdirSync(p).filter((f) => f.endsWith('.json') || f.endsWith('.output')).sort() } catch (e) {
      process.stderr.write(`cannot read ${p}: ${e.message}\n`); status = 1; continue
    }
    for (const f of names) {
      const full = join(p, f)
      let isFile
      try { isFile = statSync(full).isFile() } catch (e) {
        process.stderr.write(`cannot read ${full}: ${e.message}\n`); status = 1; continue
      }
      if (isFile) load(full, true)
    }
  }

  const report = summarise(runIds(results), { includeConcurrent: flags.has('--include-concurrent'), last, since, untimedFirst: discover })
  if (found) report.discovered = { root: found.root, files: found.files.length }
  if (found && !report.runs.length && !flags.has('--json')) {
    // An empty table would read as zero cost; say plainly that nothing was found,
    // or, when runs were found, that --since excluded them all. (--last N >= 1
    // keeps at least one run, so it never empties a non-empty list.)
    const n = report.skipped.length
    const matched = report.filter?.found
      ? `no runs match --since ${values['--since']} (${report.filter.found} found under ${found.root}` +
        `${n ? `; skipped ${plural(n, 'file')}, --verbose lists them` : ''})`
      : `no runs found under ${found.root}${n ? ` (skipped ${plural(n, 'file')}; --verbose lists them)` : ''}`
    process.stdout.write(`${matched}\n`)
    if (n && flags.has('--verbose')) for (const x of report.skipped) process.stdout.write(`  skipped: ${x.id} (${x.reason})\n`)
    return status
  }
  process.stdout.write(flags.has('--json') ? `${JSON.stringify(report, null, 2)}\n` : render(report, { verbose: flags.has('--verbose') }))
  return status
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
