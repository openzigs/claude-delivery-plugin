#!/usr/bin/env node
//
// Compare model tiers on the light-review eval suite under evals/. Stdlib only, read-only.
//
//   claude plugin eval . --model haiku  --ablation none --json haiku.json
//   claude plugin eval . --model sonnet --ablation none --json sonnet.json
//   node scripts/eval-tiers.mjs haiku.json sonnet.json [--json]
//
// One row per result file (`aggregate-result.json`, or a `--json` output): the tier is the
// run's --model, recall is the share of `seeded-*` cases whose seeded defect was found, and
// spend is the run's list-price cost and turns. With --runs N a case counts as found only if
// every run scored 1 (a case that missed in one of three runs is listed as missed). Output tokens are not reported because the
// eval result records none (schemaVersion 1); cost is the per-tier spend it does record.
//
// Every `control-*` case seeds a defect no reviewer can see, so it must score 0. If one
// scores above 0 the grader cannot fail, the recall beside it means nothing, and this
// script says so and exits 1.
import { readFileSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function summarise(doc, id) {
  const cases = Array.isArray(doc?.cases) ? doc.cases : null
  if (!cases || doc.schemaVersion !== 1) return null
  const score = (c) => {
    const runs = c?.arms?.with || []
    return runs.length ? runs.reduce((n, r) => n + (Number(r?.score) || 0), 0) / runs.length : 0
  }
  const seeded = cases.filter((c) => String(c.name).startsWith('seeded-'))
  const controls = cases.filter((c) => String(c.name).startsWith('control-'))
  const found = seeded.filter((c) => score(c) >= 1).length
  const runs = cases.flatMap((c) => c?.arms?.with || [])
  const turns = runs.reduce((n, r) => n + (Number(r?.turns) || 0), 0)
  return {
    id,
    tier: doc.suite?.modelOverride || 'default model',
    seeded: seeded.length,
    found,
    recall: seeded.length ? found / seeded.length : null,
    controlsFailedAsExpected: controls.every((c) => score(c) === 0),
    controls: controls.length,
    costUsd: typeof doc.costUsd === 'number' ? doc.costUsd : null,
    meanTurns: runs.length ? turns / runs.length : null,
    partial: Boolean(doc.partial),
    missed: seeded.filter((c) => score(c) < 1).map((c) => c.name),
  }
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
  for (const p of paths) {
    let doc
    try { doc = JSON.parse(readFileSync(p, 'utf8')) } catch (e) { console.error(`cannot read ${p}: ${e.message}`); status = 1; continue }
    const row = summarise(doc, basename(p))
    if (!row) { console.error(`${p}: not a claude plugin eval result (schemaVersion 1)`); status = 1; continue }
    if (!row.controlsFailedAsExpected) status = 1
    rows.push(row)
  }
  if (asJson) console.log(JSON.stringify({ rows }, null, 2))
  else {
    const fmt = (r) => [r.tier, `${r.found}/${r.seeded}`, r.recall == null ? 'n/a' : `${Math.round(r.recall * 100)}%`,
      r.controlsFailedAsExpected ? `ok (${r.controls} scored 0)` : 'SCORER CANNOT FAIL', r.costUsd == null ? 'n/a' : `$${r.costUsd.toFixed(4)}`,
      r.meanTurns == null ? 'n/a' : r.meanTurns.toFixed(1), r.partial ? 'PARTIAL' : '', r.missed.join(', ')]
    const head = ['tier', 'found', 'recall', 'control', 'costUsd', 'turns/run', 'note', 'missed']
    const table = [head, ...rows.map(fmt)]
    const w = head.map((_, i) => Math.max(...table.map((t) => String(t[i]).length)))
    for (const t of table) console.log(t.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd())
    console.log('Output tokens are not reported: the eval result records none. costUsd is list price, including any judge calls.')
  }
  process.exit(status)
}
