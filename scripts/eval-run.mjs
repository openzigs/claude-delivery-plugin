#!/usr/bin/env node
//
// Run the review eval matrix and report it. Stdlib only. Costs real model calls.
//
//   node scripts/eval-run.mjs --dry-run                     # print what would run
//   node scripts/eval-run.mjs                               # haiku, sonnet, session x light, full, batch; N=3
//   node scripts/eval-run.mjs --tier haiku --scope light --runs 1
//
// Options: --tier haiku|sonnet|session (repeatable; default all three), --scope light|full|batch
// (repeatable; default all three), --runs N (default 3), -j N (concurrent runs, default 4),
// --max-cost-usd X (a ceiling per tier x scope call), --out DIR (default
// evals/results/matrix-<timestamp>, gitignored), --dry-run.
//
// One `claude plugin eval` call per tier x scope, each with:
//   --scaffold          the cases build their fixture repository (scripts/eval-scaffold.mjs)
//   --allow-tools Bash  the reviewer reads the repository and runs commands, under the eval sandbox
//   --ablation none     no no-plugin baseline arm: without the plugin there is no reviewer agent
//   --keep-temp         each run's trace is kept so the report can count the reviewer's turns and
//                       read its findings; this script copies the trace into --out and deletes the
//                       kept directory
// "session" passes no --model, so the run uses Claude Code's default model. Every agent the
// session dispatches inherits its model: the reviewer runs on the tier under test.
//
// Then scripts/eval-tiers.mjs reports every result file, and this script exits with its status.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TIERS = ['haiku', 'sonnet', 'session']
export const SCOPES = ['light', 'full', 'batch']

export function parseArgs(argv) {
  const o = { tiers: [], scopes: [], runs: 3, concurrency: 4, maxCost: null, out: null, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v == null || v.startsWith('--')) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--tier') o.tiers.push(val())
    else if (a === '--scope') o.scopes.push(val())
    else if (a === '--runs') o.runs = Number(val())
    else if (a === '-j' || a === '--concurrency') o.concurrency = Number(val())
    else if (a === '--max-cost-usd') o.maxCost = Number(val())
    else if (a === '--out') o.out = val()
    else if (a === '--dry-run') o.dryRun = true
    else throw new Error(`unknown option ${a}`)
  }
  if (!o.tiers.length) o.tiers = [...TIERS]
  if (!o.scopes.length) o.scopes = [...SCOPES]
  for (const t of o.tiers) if (!TIERS.includes(t)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`)
  for (const s of o.scopes) if (!SCOPES.includes(s)) throw new Error(`--scope must be one of ${SCOPES.join(', ')}`)
  if (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 50) throw new Error('--runs must be an integer from 1 to 50')
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1 || o.concurrency > 8) throw new Error('-j must be an integer from 1 to 8')
  if (o.maxCost != null && !(o.maxCost > 0)) throw new Error('--max-cost-usd must be a positive number')
  return o
}

export function evalArgs(o, tier, scope, json) {
  return [
    'plugin', 'eval', ROOT,
    '--tag', `${scope}-review`,
    '--runs', String(o.runs),
    '--ablation', 'none',
    '--scaffold',
    '--allow-tools', 'Bash',
    '--trust-plugin',
    '--no-publish',
    '--keep-temp',
    '-j', String(o.concurrency),
    ...(tier === 'session' ? [] : ['--model', tier]),
    ...(o.maxCost != null ? ['--max-cost-usd', String(o.maxCost)] : []),
    '--json', json,
  ]
}

// A kept run directory is /tmp/e-XXXX (or under the OS temp dir); refuse anything else.
export function keptDirOf(tracePath) {
  const d = dirname(dirname(tracePath || ''))
  const parent = dirname(d)
  const temps = new Set(['/tmp', '/private/tmp', tmpdir()].map((p) => (existsSync(p) ? realpathSync(p) : p)))
  return /^e-[A-Za-z0-9]+$/.test(basename(d)) && existsSync(parent) && temps.has(realpathSync(parent)) ? d : null
}

// Copy every run's trace next to the result, point tracePath at the copy, delete the kept dir.
export function harvest(jsonPath, label) {
  const doc = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const outDir = dirname(jsonPath)
  let kept = 0
  for (const c of doc.cases || []) {
    for (const [i, r] of (c.arms?.with || []).entries()) {
      if (!r.tracePath || !existsSync(r.tracePath)) continue
      const dest = join(outDir, 'traces', label, c.name, `run-${i + 1}.jsonl`)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(r.tracePath, dest)
      const kd = keptDirOf(r.tracePath)
      r.tracePath = relative(outDir, dest)
      if (kd) {
        spawnSync('chmod', ['-R', 'u+rwx', kd])
        rmSync(kd, { recursive: true, force: true })
      }
      kept++
    }
  }
  writeFileSync(jsonPath, JSON.stringify(doc, null, 2))
  return kept
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) { console.error(`eval-run: ${e.message}`); process.exit(2) }
  const out = resolve(o.out || join(ROOT, 'evals', 'results', `matrix-${new Date().toISOString().replace(/[:.]/g, '-')}`))
  const plan = o.tiers.flatMap((tier) => o.scopes.map((scope) => ({ tier, scope, json: join(out, `${tier}-${scope}.json`) })))
  if (o.dryRun) {
    for (const p of plan) console.log(['claude', ...evalArgs(o, p.tier, p.scope, p.json)].join(' '))
    console.log(`then: node scripts/eval-tiers.mjs ${plan.map((p) => relative(process.cwd(), p.json)).join(' ')}`)
    process.exit(0)
  }
  mkdirSync(out, { recursive: true })
  const written = []
  for (const p of plan) {
    const t0 = Date.now()
    console.error(`eval-run: ${p.tier} x ${p.scope} (N=${o.runs}) ...`)
    const r = spawnSync('claude', evalArgs(o, p.tier, p.scope, p.json), { stdio: ['ignore', 'inherit', 'inherit'] })
    // 0 = every case passed, 1 = some case scored below 1 (expected: misses are data), 2 = partial.
    if (!existsSync(p.json)) { console.error(`eval-run: ${p.tier} x ${p.scope} wrote no result (exit ${r.status})`); continue }
    const kept = harvest(p.json, `${p.tier}-${p.scope}`)
    console.error(`eval-run: ${p.tier} x ${p.scope} done in ${Math.round((Date.now() - t0) / 1000)}s (exit ${r.status}, ${kept} traces kept)`)
    written.push(p.json)
  }
  if (!written.length) process.exit(1)
  const rep = spawnSync(process.execPath, [join(ROOT, 'scripts', 'eval-tiers.mjs'), ...written], { stdio: 'inherit' })
  process.exit(rep.status ?? 1)
}
