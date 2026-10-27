#!/usr/bin/env node
//
// Pipeline replay benchmark: run /delivery:orchestrate and /delivery:plan-epic, as a given
// plugin ref, against the fixture repository in bench/, and record what each run cost.
// EXPENSIVE and opt-in: a full run of both refs is in the order of a few million tokens.
// It is never run by CI. See docs/benchmarks.md.
//
//   node scripts/bench-run.mjs --ref 6567d82 --ref HEAD --repo <owner>/<scratch-repo> --reset-scratch
//   node scripts/bench-run.mjs --ref HEAD --repo <owner>/<scratch-repo> --scenario plan-epic --runs 3 --reset-scratch
//   node scripts/bench-run.mjs --ref HEAD --repo <owner>/<scratch-repo> --dry-run     # print the plan, run nothing
//   node scripts/bench-report.mjs
//
// The pipeline opens issues and pull requests and watches CI, so it needs ONE GitHub
// repository you own and do not care about: --repo. Every run force-pushes the fixture as
// that repository's `main` and files the canned issues in it, which is why --reset-scratch
// must be passed to say so. Nothing else on GitHub is touched.
//
// For each ref and run: a detached git worktree of this repository at the ref is the plugin
// (`claude --plugin-dir`, which takes precedence over an installed `delivery` plugin); a fresh
// temporary copy of bench/fixture-repo is the project. Scenario `orchestrate` runs three
// separate `claude -p` calls -- small (--points 1: sonnet implement, light review), medium
// (--points 3: full review) and trap (--points 3; a planted requirement the obvious
// implementation misses, to draw a blocking finding, a fix and a re-review). Scenario
// `plan-epic` runs one, on bench/topics/plan-epic.md. The calls run with
// --dangerously-skip-permissions. That is NOT confined: the agents have an unrestricted shell
// and whatever `gh` credentials you are logged in with. Run it with a GH_TOKEN that can reach
// only the scratch repository (a fine-grained token), and not on a machine holding secrets.
// Each call's JSON output, its wall time and the session Claude Code persisted (workflow
// results and subagent transcripts) are copied to bench/results/<ref>/<scenario>/run-<n>/,
// which bench-report.mjs reads.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BENCH = join(ROOT, 'bench')
export const SCENARIOS = ['orchestrate', 'plan-epic']
export const ISSUES = [
  { name: 'small', points: 1 },
  { name: 'medium', points: 3 },
  { name: 'trap', points: 3 },
]

// Claude Code's project directory for a working directory: its real path, every character
// that is not a letter or digit replaced by '-'.
export const projectSlug = (dir) => realpathSync(dir).replace(/[^A-Za-z0-9]/g, '-')

export function parseIssue(md) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(md.replace(/\r\n/g, '\n'))
  if (!m) throw new Error('issue file has no front matter')
  const fm = Object.fromEntries(m[1].split('\n').map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2].trim()]))
  return { title: fm.title, labels: (fm.labels || '').split(',').map((s) => s.trim()).filter(Boolean), points: Number(fm.points), body: m[2].trim() + '\n' }
}

export function parseArgs(argv) {
  const o = { refs: [], scenarios: [...SCENARIOS], runs: 1, timeoutMin: 120, repo: null, out: join(BENCH, 'results'), dryRun: false, reset: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`); return argv[++i] }
    if (a === '--ref') o.refs.push(val())
    else if (a === '--repo') o.repo = val()
    else if (a === '--scenario') { const s = val(); o.scenarios = s === 'all' ? [...SCENARIOS] : [s] }
    else if (a === '--runs') o.runs = Number(val())
    else if (a === '--timeout-min') o.timeoutMin = Number(val())
    else if (a === '--out') o.out = resolve(val())
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--reset-scratch') o.reset = true
    else if (a === '--keep') o.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!o.refs.length) throw new Error('give at least one --ref')
  for (const r of o.refs) if (r.startsWith('-')) throw new Error(`not a git ref: ${JSON.stringify(r)}`)
  if (!o.scenarios.every((s) => SCENARIOS.includes(s))) throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')} or all`)
  if (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 20) throw new Error('--runs must be an integer from 1 to 20')
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0) throw new Error('--timeout-min must be a positive number of minutes')
  const dirs = o.refs.map((r) => r.replace(/[^A-Za-z0-9._-]/g, '_'))
  if (new Set(dirs).size !== dirs.length) throw new Error('two --ref values map to the same results directory (HEAD~1 and HEAD^1 both become HEAD_1); name them differently, e.g. by tag or branch')
  if (!o.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.repo)) throw new Error('--repo <owner>/<scratch-repo> is required: the pipeline opens issues and PRs there')
  if (!o.dryRun && !o.reset) throw new Error(`--reset-scratch is required: every run force-pushes the fixture as ${o.repo}'s main and files issues in it`)
  return o
}

// The claude call for one dispatch of the pipeline.
export const claudeArgs = (prompt, pluginDir) =>
  ['-p', prompt, '--plugin-dir', pluginDir, '--output-format', 'json', '--dangerously-skip-permissions']

export function plan(o) {
  const steps = []
  for (const ref of o.refs) {
    for (let run = 1; run <= o.runs; run++) {
      for (const scenario of o.scenarios) {
        const calls = scenario === 'orchestrate'
          ? ISSUES.map((i) => ({ issue: i.name, prompt: `/delivery:orchestrate <#${i.name}> --points ${i.points}` }))
          : [{ issue: null, prompt: '/delivery:plan-epic ./PLAN-TOPIC.md' }]
        steps.push({ ref, run, scenario, calls, out: join(o.out, ref.replace(/[^A-Za-z0-9._-]/g, '_'), scenario, `run-${run}`) })
      }
    }
  }
  return steps
}

// Results of an earlier call for the same ref and scenario would be read again by the report
// (sessions of a previous run, run-N directories from a larger --runs), so start each from empty.
export function clearResults(steps) {
  for (const d of new Set(steps.map((s) => dirname(s.out)))) rmSync(d, { recursive: true, force: true })
}

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function runStep(step, o) {
  const sha = sh('git', ['-C', ROOT, 'rev-parse', '--verify', '--end-of-options', `${step.ref}^{commit}`])
  const tmp = mkdtempSync(join(tmpdir(), 'delivery-bench-'))
  const pluginDir = join(tmp, 'plugin')
  const work = join(tmp, 'work')
  sh('git', ['-C', ROOT, 'worktree', 'add', '--detach', pluginDir, sha])
  try {
    cpSync(join(BENCH, 'fixture-repo'), work, { recursive: true })
    sh('git', ['init', '-q', '-b', 'main'], work)
    sh('git', ['add', '-A'], work)
    sh('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-q', '-m', 'fixture'], work)
    sh('git', ['remote', 'add', 'origin', `https://github.com/${o.repo}.git`], work)
    sh('git', ['push', '-q', '--force', 'origin', 'main'], work)
    const calls = []
    let prompts = step.calls
    if (step.scenario === 'orchestrate') {
      prompts = step.calls.map((c) => {
        const is = parseIssue(readFileSync(join(BENCH, 'issues', `${c.issue}.md`), 'utf8'))
        for (const l of is.labels) sh('gh', ['label', 'create', l, '--repo', o.repo, '--force'], work)
        const url = sh('gh', ['issue', 'create', '--repo', o.repo, '--title', is.title, '--body', is.body, ...is.labels.flatMap((l) => ['--label', l])], work)
        const n = Number(/\/issues\/(\d+)\s*$/.exec(url)?.[1])
        if (!n) throw new Error(`could not read the issue number from ${url}`)
        return { ...c, number: n, prompt: c.prompt.replace(`<#${c.issue}>`, String(n)) }
      })
    } else {
      cpSync(join(BENCH, 'topics', 'plan-epic.md'), join(work, 'PLAN-TOPIC.md'))
    }
    mkdirSync(step.out, { recursive: true })
    // The planner's reply is free text, so plan-epic is judged by the scratch repo gaining issues.
    const issueCount = () => JSON.parse(sh('gh', ['issue', 'list', '--repo', o.repo, '--state', 'all', '--limit', '1000', '--json', 'number'], work)).length
    prompts.forEach((c, k) => {
      const issuesBefore = step.scenario === 'plan-epic' ? issueCount() : null
      const t0 = Date.now()
      const r = spawnSync('claude', claudeArgs(c.prompt, pluginDir), { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: o.timeoutMin * 60000 })
      const wallMs = Date.now() - t0
      writeFileSync(join(step.out, `claude-${k + 1}.json`), r.stdout || '{}')
      const issuesAfter = step.scenario === 'plan-epic' ? issueCount() : null
      let sessionId = null
      try { sessionId = JSON.parse(r.stdout).session_id } catch {}
      let sessionFound = false
      if (sessionId && /^[A-Za-z0-9-]+$/.test(sessionId)) {
        const src = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', projectSlug(work), sessionId)
        if (existsSync(src)) { cpSync(src, join(step.out, 'sessions', sessionId), { recursive: true }); sessionFound = true }
      }
      calls.push({ prompt: c.prompt, issue: c.issue, number: c.number ?? null, wallMs, exit: r.status, sessionId, sessionFound, issuesBefore, issuesAfter })
      console.log(`  ${step.ref} ${step.scenario} run ${step.run}: ${c.prompt} — exit ${r.status}, ${(wallMs / 60000).toFixed(1)} min`)
    })
    writeFileSync(join(step.out, 'meta.json'), JSON.stringify({ ref: step.ref, sha, scenario: step.scenario, run: step.run, repo: o.repo, calls }, null, 2) + '\n')
  } finally {
    spawnSync('git', ['-C', ROOT, 'worktree', 'remove', '--force', pluginDir])
    if (!o.keep) rmSync(tmp, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  let o
  try { o = parseArgs(process.argv.slice(2)) } catch (e) {
    console.error(`bench-run: ${e.message}\nusage: node scripts/bench-run.mjs --ref <git-ref>... --repo <owner>/<scratch-repo> ` +
      '--reset-scratch [--scenario orchestrate|plan-epic|all] [--runs N] [--timeout-min M] [--out DIR] [--keep] [--dry-run]')
    process.exit(2)
  }
  const steps = plan(o)
  console.log(`${o.dryRun ? 'DRY RUN — nothing will be executed. ' : ''}${steps.length} step(s), ` +
    `${steps.reduce((n, s) => n + s.calls.length, 0)} claude -p call(s); scratch repo ${o.repo}. ` +
    'Expect a few million tokens for both scenarios on two refs.')
  for (const s of steps) {
    console.log(`${s.ref} / ${s.scenario} / run ${s.run} -> ${s.out}`)
    for (const c of s.calls) console.log(`  claude ${claudeArgs(c.prompt, '<worktree of ' + s.ref + '>').map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
  }
  if (o.dryRun) process.exit(0)
  clearResults(steps)
  for (const s of steps) runStep(s, o)
  console.log('\nDone. node scripts/bench-report.mjs')
}
