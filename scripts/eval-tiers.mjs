#!/usr/bin/env node
//
// Compare model tiers on the review eval suite under evals/. Stdlib only, read-only.
//
//   claude plugin eval . --tag light-review --model haiku --ablation none --json haiku-light.json
//   claude plugin eval . --tag full-review  --model haiku --ablation none --json haiku-full.json
//   node scripts/eval-tiers.mjs haiku-light.json haiku-full.json [--json]
//
// One row per result file and review scope (`aggregate-result.json`, or a `--json` output). The
// tier is the run's --model; the scope is LIGHT for a case named `<case>` and FULL for one named
// `<case>-full` (the copies under evals/full/). Recall is the share of `seeded-*` cases whose
// seeded defect was found, overall and per category (the category is the case's tag in its
// case.yaml: security, correctness, performance, tests, requirements). A false block is a
// `clean-*` case -- a diff with nothing to block -- that did not end in `Recommendation: merge`.
// Spend is the run's list-price cost and mean turns per run. With --runs N a seeded case counts
// as found only if every run scored 1, and a clean case counts as a false block if any run
// blocked. Output tokens are not reported because the eval result records none (schemaVersion
// 1). Effort is not compared: `claude plugin eval` has no effort flag.
//
// Every `control-*` case seeds a defect no reviewer can see, so it must score 0. If one
// scores above 0 the grader cannot fail, the recall beside it means nothing, and this
// script says so and exits 1.
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CATEGORIES = ['security', 'correctness', 'performance', 'tests', 'requirements']
const EVALS = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals')

// Case name -> category, from the `tags:` line of each case.yaml under evals/.
export function loadCategories(dir = EVALS) {
  const out = {}
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const y = join(dir, e.name, 'case.yaml')
    if (!e.isDirectory() || !existsSync(y)) continue
    const tags = (/^tags:\s*\[([^\]]*)\]/m.exec(readFileSync(y, 'utf8'))?.[1] || '').split(',').map((t) => t.trim())
    const cat = tags.find((t) => CATEGORIES.includes(t))
    if (cat) out[e.name] = cat
  }
  return out
}

export function summarise(doc, id, categories = loadCategories()) {
  const cases = Array.isArray(doc?.cases) ? doc.cases : null
  if (!cases || doc.schemaVersion !== 1) return null
  const runsOf = (c) => c?.arms?.with || []
  const score = (c) => (runsOf(c).length ? runsOf(c).reduce((n, r) => n + (Number(r?.score) || 0), 0) / runsOf(c).length : 0)
  const base = (c) => String(c.name).replace(/-full$/, '')
  const scopeOf = (c) => (String(c.name).endsWith('-full') ? 'full' : 'light')
  const scopes = [...new Set(cases.map(scopeOf))].sort()
  return scopes.map((scope) => {
    const mine = cases.filter((c) => scopeOf(c) === scope)
    const seeded = mine.filter((c) => base(c).startsWith('seeded-'))
    const controls = mine.filter((c) => base(c).startsWith('control-'))
    const clean = mine.filter((c) => base(c).startsWith('clean-'))
    const found = seeded.filter((c) => score(c) >= 1)
    const byCategory = {}
    for (const k of [...CATEGORIES, 'uncategorised']) {
      const inK = seeded.filter((c) => (categories[base(c)] || 'uncategorised') === k)
      if (inK.length) byCategory[k] = { found: inK.filter((c) => score(c) >= 1).length, seeded: inK.length }
    }
    const runs = mine.flatMap(runsOf)
    const turns = runs.reduce((n, r) => n + (Number(r?.turns) || 0), 0)
    const runCost = runs.every((r) => typeof r?.costUsd === 'number') ? runs.reduce((n, r) => n + r.costUsd, 0) : null
    const falseBlocks = clean.filter((c) => score(c) < 1).map((c) => c.name)
    return {
      id,
      tier: doc.suite?.modelOverride || 'default model',
      scope,
      seeded: seeded.length,
      found: found.length,
      recall: seeded.length ? found.length / seeded.length : null,
      byCategory,
      clean: clean.length,
      falseBlocks: falseBlocks.length,
      falseBlockRate: clean.length ? falseBlocks.length / clean.length : null,
      falseBlocked: falseBlocks,
      controlsFailedAsExpected: controls.every((c) => score(c) === 0),
      controls: controls.length,
      // One scope in the file: the run's own total. Both: each scope's share, summed per run.
      costUsd: scopes.length === 1 && typeof doc.costUsd === 'number' ? doc.costUsd : runCost,
      meanTurns: runs.length ? turns / runs.length : null,
      partial: Boolean(doc.partial),
      missed: seeded.filter((c) => score(c) < 1).map((c) => c.name),
    }
  })
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const paths = args.filter((a) => a !== '--json')
  if (!paths.length) {
    console.log('usage: node scripts/eval-tiers.mjs <aggregate-result.json>... [--json]')
    process.exit(2)
  }
  const rows = []
  let status = 0
  const categories = loadCategories()
  for (const p of paths) {
    let doc
    try { doc = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { console.error(`cannot read ${p}: ${e.message}`); status = 1; continue }
    const got = summarise(doc, basename(p), categories)
    if (!got) { console.error(`${p}: not a claude plugin eval result (schemaVersion 1)`); status = 1; continue }
    if (got.some((r) => !r.controlsFailedAsExpected)) status = 1
    rows.push(...got)
  }
  if (asJson) console.log(JSON.stringify({ rows }, null, 2))
  else {
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a')
    const cat = (r, k) => (r.byCategory[k] ? `${r.byCategory[k].found}/${r.byCategory[k].seeded}` : '-')
    const fmt = (r) => [r.tier, r.scope, `${r.found}/${r.seeded}`, pct(r.found, r.seeded), ...CATEGORIES.map((k) => cat(r, k)),
      r.clean ? `${r.falseBlocks}/${r.clean}` : 'n/a',
      r.controlsFailedAsExpected ? `ok (${r.controls} scored 0)` : 'SCORER CANNOT FAIL', r.costUsd == null ? 'n/a' : `$${r.costUsd.toFixed(4)}`,
      r.meanTurns == null ? 'n/a' : r.meanTurns.toFixed(1), r.partial ? 'PARTIAL' : '', r.missed.join(', ')]
    const head = ['tier', 'scope', 'found', 'recall', ...CATEGORIES, 'false blocks', 'control', 'costUsd', 'turns/run', 'note', 'missed']
    const table = [head, ...rows.map(fmt)]
    const w = head.map((_, i) => Math.max(...table.map((t) => String(t[i]).length)))
    for (const t of table) console.log(t.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd())
    console.log('Output tokens are not reported: the eval result records none. costUsd is list price, including any judge calls.')
    console.log('Effort was not compared: claude plugin eval has no effort flag, so every row ran at the CLI default effort.')
  }
  process.exit(status)
}
