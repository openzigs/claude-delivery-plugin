#!/usr/bin/env node
//
// What the reviews found, across saved /delivery:orchestrate results: how often a PR went to a
// fix pass, how often it was still blocking afterwards, what class of defect blocked it, where
// in the tree, and which routes never fired. Stdlib only, read-only: it opens its inputs for
// reading and writes only to stdout and stderr.
//
//   node scripts/findings-report.mjs [--json] [--no-notes] <result.json | task.output | dir>...
//   node scripts/findings-report.mjs [--json] [--no-notes] --discover [--last N]
//
// Inputs are found and unwrapped exactly as scripts/cost-report.mjs does (its helpers are
// imported), so anything that script reads, this one reads.
//
// It prints counts, the top-level directories blocking findings point at, and the run's own
// suggestedProjectNotes (which the workflow already returns as suggestions). It never prints a
// finding's summary, a review body or an implementer's report: the classes below are counted
// from that text, and only the count leaves this script.
//
// The arithmetic and the classification live here so that no model ever does either.
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unwrap, discoverFiles, configDir } from './cost-report.mjs'

// First match wins, so the order is the priority. Keyword classes are a proxy: they say where
// to look, not what is true. `owner-or-wait` uses the review's own resolvableBy when it has
// one, and the wording only for results saved before that field existed.
export const CLASSES = [
  ['owner-or-wait', /owner[- ](approv|gate|ruling|sign)|owner (must|has not|has to|needs to)|only the owner|not fixable in code|no code change possible|human (must|gate|prerequisite)|(still|is|are|all) (pending|queued)|infrastructure fault/i],
  ['ci', /\bCI\b|failing check|check(s)? (is|are|was) (red|failing)|pipeline|workflow run/i],
  ['security', /secur|inject|\bauth(n|z|entic|ori[sz])|tenant|secret|XSS|CSRF|traversal|permission/i],
  ['requirements', /acceptance|criterion|criteria|requirement|issue (asks|says|requires)|not (met|implemented)|missing: /i],
  ['tests', /\btests?\b|mutation|coverage|assert|fixture|cannot fail/i],
  ['docs-changelog', /changelog|fragment|architecture doc|documentation|README|\bdocs?\b/i],
  ['scope', /scope creep|unrelated|reformat/i],
]
export const classOf = (f) => {
  if (f?.resolvableBy === 'owner' || f?.resolvableBy === 'wait') return 'owner-or-wait'
  const text = typeof f?.summary === 'string' ? f.summary : ''
  for (const [name, re] of CLASSES) if (re.test(text)) return name
  return 'other'
}
// The first path segment of a finding's location, or '(general)'. A path only, never its text.
export const areaOf = (f) => {
  const loc = typeof f?.location === 'string' ? f.location.trim() : ''
  if (!loc || /^general$/i.test(loc) || /\s/.test(loc.split(':')[0])) return '(general)'
  const file = loc.split(':')[0].replace(/^\.?\//, '')
  return file.includes('/') ? `${file.split('/')[0]}/` : file
}

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n }
const arr = (x) => (Array.isArray(x) ? x : [])

export function summarise(results) {
  const t = {
    runs: 0, batches: 0, multiIssueBatches: 0, smallTierBatches: 0, prs: 0, reviewDidNotReturn: 0,
    lightReviews: 0, noStoryPoints: 0, fixCycles: 0, stillBlocking: 0, awaitingOwner: 0, fixSkippedForOwner: 0,
    fixGatesFailed: 0, fixNotPushed: 0, fixChanged: 0, fixDeclined: 0, withheldFromFix: 0, suppressed: 0,
    findings: 0, severity: {}, blockingClass: {}, stillBlockingClass: {}, blockingArea: {}, notes: {},
  }
  for (const data of results) {
    if (!data || !Array.isArray(data.batches)) continue
    t.runs++
    for (const b of data.batches) {
      t.batches++
      if (arr(b?.issues).length > 1) t.multiIssueBatches++
      if (typeof b?.implementModel === 'string' && b.implementModel !== 'session model') t.smallTierBatches++
      for (const p of arr(b?.prs)) {
        if (!p || p.sameReviewAs != null) continue
        t.prs++
        if (p.reviewCompleted === false) { t.reviewDidNotReturn++; continue }
        if (p.reviewScope === 'light') t.lightReviews++
        if (/^no story points/.test(p.reviewRouting || '')) t.noStoryPoints++
        t.suppressed += Number.isInteger(p.suppressedFindings) ? p.suppressedFindings : 0
        t.withheldFromFix += Number.isInteger(p.withheldFromFix) ? p.withheldFromFix : 0
        const findings = arr(p.review?.findings)
        t.findings += findings.length
        for (const f of findings) bump(t.severity, f?.severity ?? 'unknown')
        const blockers = findings.filter((f) => f?.blocking)
        for (const f of blockers) { bump(t.blockingClass, classOf(f)); bump(t.blockingArea, areaOf(f)) }
        if (arr(p.awaiting).length) t.awaitingOwner++
        if (arr(p.awaiting).length && !p.fix) t.fixSkippedForOwner++
        if (p.fix) {
          t.fixCycles++
          const g = p.fix.gates || {}
          if (g.passed === false) t.fixGatesFailed++
          if (g.pushed === false) t.fixNotPushed++
          t.fixChanged += arr(p.fix.changed).length
          t.fixDeclined += arr(p.fix.declined).length
        }
        if (p.stillBlocking) {
          t.stillBlocking++
          for (const f of arr(p.reReview?.findings).filter((x) => x?.blocking)) bump(t.stillBlockingClass, classOf(f))
        }
      }
    }
    for (const n of arr(data.suggestedProjectNotes)) {
      if (typeof n === 'string' && n.trim()) bump(t.notes, n.trim().replace(/\s+/g, ' ').slice(0, 500))
    }
  }
  return t
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a')
const share = (n, d) => (d ? n / d : 0)

// What the numbers suggest, by fixed rule. Each line names its own evidence, so a reader can
// disagree with the threshold without re-deriving the count.
export function suggestions(t) {
  const out = []
  const blockers = Object.values(t.blockingClass).reduce((a, b) => a + b, 0)
  const cls = (k) => t.blockingClass[k] || 0
  if (t.prs >= 10 && share(t.noStoryPoints, t.prs) > 0.3) {
    out.push(`${pct(t.noStoryPoints, t.prs)} of reviewed PRs had no Story Points line, so every one took the full review and the size routing never applied. Add the line when filing (the epic planner does), or run with --triage.`)
  }
  if (t.batches >= 10 && share(t.smallTierBatches, t.batches) < 0.05) {
    out.push(`${t.smallTierBatches} of ${t.batches} batches were implemented on the small tier. Pass --points or --small for small issues, or run with --triage.`)
  }
  if (blockers >= 10 && share(cls('owner-or-wait'), blockers) > 0.15) {
    out.push(`${pct(cls('owner-or-wait'), blockers)} of blocking findings were an owner's gate or a wait, which no fix pass can clear. Results from before resolvableBy paid a fix and a re-review for each; say in .claude/delivery.md which criteria are the owner's, so the implementer lists them as owner: in the PR body.`)
  }
  if (blockers >= 10 && share(cls('tests'), blockers) > 0.3) {
    out.push(`${pct(cls('tests'), blockers)} of blocking findings were about tests. Add the recurring shape to "Review emphasis" and "Known traps" in .claude/delivery.md, so the implementer meets it before the reviewer does.`)
  }
  if (blockers >= 10 && share(cls('requirements'), blockers) > 0.2) {
    out.push(`${pct(cls('requirements'), blockers)} of blocking findings were unmet requirements. Check that issues carry checkable acceptance criteria, and that PR bodies list one line per criterion.`)
  }
  if (blockers >= 10 && share(cls('ci'), blockers) > 0.1) {
    out.push(`${pct(cls('ci'), blockers)} of blocking findings were about CI. Name the exact gate commands in .claude/delivery.md so they run locally before the push.`)
  }
  if (t.fixCycles >= 10 && share(t.stillBlocking, t.fixCycles) > 0.25) {
    out.push(`${pct(t.stillBlocking, t.fixCycles)} of fix cycles were still blocking after the re-review. Read the "still blocking, by class" line: a code class there means the fix tier is too weak for this project (try --small-model inherit); owner-or-wait means the cycles could not have succeeded.`)
  }
  if (t.fixCycles >= 10 && share(t.fixNotPushed + t.fixGatesFailed, t.fixCycles) > 0.1) {
    out.push(`${t.fixNotPushed} fixes were not pushed and ${t.fixGatesFailed} failed their gates, of ${t.fixCycles}. Check the gate commands the project documents actually run for a dispatched agent.`)
  }
  const area = Object.entries(t.blockingArea).filter(([k]) => k !== '(general)').sort((a, b) => b[1] - a[1])[0]
  if (area && blockers >= 10 && share(area[1], blockers) > 0.4) {
    out.push(`${pct(area[1], blockers)} of blocking findings point into ${area[0]}. A note on what goes wrong there belongs in .claude/delivery.md.`)
  }
  return out
}

const ranked = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
const line = (o, total) => (ranked(o).length ? ranked(o).map(([k, v]) => `${k} ${v}${total ? ` (${pct(v, total)})` : ''}`).join(', ') : 'none')

export function render(t, { notes = true } = {}) {
  const blockers = Object.values(t.blockingClass).reduce((a, b) => a + b, 0)
  const still = Object.values(t.stillBlockingClass).reduce((a, b) => a + b, 0)
  const out = [
    `runs ${t.runs}, batches ${t.batches} (${t.multiIssueBatches} with more than one issue), PRs reviewed ${t.prs}`,
    '',
    'routing',
    `  implemented on the small tier   ${t.smallTierBatches} of ${t.batches} batches (${pct(t.smallTierBatches, t.batches)})`,
    `  light reviews                   ${t.lightReviews} of ${t.prs} (${pct(t.lightReviews, t.prs)})`,
    `  no Story Points line            ${t.noStoryPoints} of ${t.prs} (${pct(t.noStoryPoints, t.prs)})`,
    `  review did not return           ${t.reviewDidNotReturn}`,
    '',
    'review and fix',
    `  fix cycles                      ${t.fixCycles} of ${t.prs} PRs (${pct(t.fixCycles, t.prs)})`,
    `  still blocking after re-review  ${t.stillBlocking} of ${t.fixCycles} (${pct(t.stillBlocking, t.fixCycles)})`,
    `  blocked on owner or a wait      ${t.awaitingOwner} PRs; fix skipped for ${t.fixSkippedForOwner}`,
    `  fix gates failed / not pushed   ${t.fixGatesFailed} / ${t.fixNotPushed}`,
    `  fix changed / declined          ${t.fixChanged} / ${t.fixDeclined}`,
    `  withheld from fix (low, nit)    ${t.withheldFromFix}`,
    `  suppressed (low confidence)     ${t.suppressed}`,
    '',
    `findings ${t.findings}: ${line(t.severity, t.findings)}`,
    `blocking findings ${blockers}, by class: ${line(t.blockingClass, blockers)}`,
    `still blocking ${still}, by class: ${line(t.stillBlockingClass, still)}`,
    `blocking findings by area: ${ranked(t.blockingArea).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
  ]
  const s = suggestions(t)
  out.push('', 'what this suggests')
  out.push(...(s.length ? s.map((x) => `  - ${x}`) : ['  nothing crosses a threshold (or there are too few runs to say)']))
  if (notes) {
    const n = ranked(t.notes)
    out.push('', `suggested project notes from the reviews (${n.length} distinct; the times each recurred)`)
    out.push(...(n.length ? n.slice(0, 20).map(([k, v]) => `  ${v}x  ${k}`) : ['  none']))
    if (n.length > 20) out.push(`  ... and ${n.length - 20} more`)
  }
  out.push('', 'Caveat: classes are counted by keyword and are a proxy; read the PRs before acting on a line.')
  return out.join('\n')
}

const USAGE = 'usage: node scripts/findings-report.mjs [--json] [--no-notes] <result.json | task.output | dir>...\n' +
  '       node scripts/findings-report.mjs [--json] [--no-notes] --discover [--last N]'

function main(argv) {
  const flags = new Set(), paths = []
  let last = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json' || a === '--no-notes' || a === '--discover') flags.add(a)
    else if (a === '--last') { last = Number(argv[++i]); if (!Number.isInteger(last) || last < 1) { console.error(`--last needs a positive integer\n${USAGE}`); return 2 } }
    else if (a.startsWith('--')) { console.error(`unknown option ${a}\n${USAGE}`); return 2 }
    else paths.push(a)
  }
  if (flags.has('--discover') ? paths.length : !paths.length) { console.error(USAGE); return 2 }
  let files = []
  let failed = false
  if (flags.has('--discover')) {
    const found = discoverFiles(configDir(), process.cwd())
    if (!found.files.length) { console.log(`no runs found under ${found.root}`); return 0 }
    files = found.files
  } else {
    for (const p of paths) {
      try {
        if (statSync(p).isDirectory()) files.push(...readdirSync(p).filter((f) => /\.(json|output)$/.test(f)).sort().map((f) => join(p, f)))
        else files.push(p)
      } catch (e) { console.error(`${p}: ${e.code || e.message}`); failed = true }
    }
  }
  const runs = []
  let skipped = 0
  for (const f of files) {
    let parsed
    try { parsed = JSON.parse(readFileSync(f, 'utf8')) } catch { skipped++; continue }
    const u = unwrap(parsed)
    if (u.skip || !u.data || !Array.isArray(u.data.batches)) { skipped++; continue }
    runs.push({ data: u.data, time: u.startTime ?? 0 })
  }
  // --last keeps the newest N by start time; untimed runs count as oldest.
  runs.sort((a, b) => a.time - b.time)
  const kept = last ? runs.slice(-last) : runs
  const t = summarise(kept.map((r) => r.data))
  if (flags.has('--json')) console.log(JSON.stringify({ ...t, suggestions: suggestions(t), ...(flags.has('--no-notes') ? { notes: undefined } : {}) }, null, 2))
  else {
    console.log(render(t, { notes: !flags.has('--no-notes') }))
    if (skipped) console.log(`skipped ${skipped} file(s) that are not an orchestrate result`)
  }
  return failed ? 1 : 0
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
