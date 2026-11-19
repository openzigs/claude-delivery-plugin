#!/usr/bin/env node
//
// Is this repository ready for /delivery:orchestrate, and where will a run spend money it does
// not need to? Stdlib only, read-only: it reads files under the current directory and runs
// read-only `gh` queries; it writes only to stdout and stderr and changes nothing.
//
//   node scripts/doctor.mjs [--json] [--no-gh]
//
// Each line is OK, WARN or INFO with the measurement it rests on. The thresholds come from the
// plugin's own rules and measurements, named beside each check below.
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// skills/code-issue/LIVING_DOCS.md: past ~40 KB the instruction file stops taking additions.
export const INSTRUCTION_FILE_BUDGET = 40 * 1024
// skills/code-issue/SKILL.md Step 5: one CI wait is at most 270 s, to stay inside the 5-minute
// prompt cache of a dispatched agent.
export const CI_WAIT_MS = 270000
export const STORY_POINTS = /\*{0,2}Story Points\*{0,2}\s*:\s*\*{0,2}\s*\d+/i

const size = (p) => { try { return statSync(p).size } catch { return null } }
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }

// Everything read from the machine, as plain data, so assess() can be tested without one.
export function gather(cwd, { gh = true, run = execFileSync } = {}) {
  const facts = {
    claudeMd: size(join(cwd, 'CLAUDE.md')), agentsMd: size(join(cwd, 'AGENTS.md')),
    deliveryMd: size(join(cwd, '.claude/delivery.md')),
    shadowedAgents: [], workflows: null, prWorkflows: null, playwrightConfig: false,
    gh: null, ciSeconds: null, ciRuns: 0, openIssues: null, withPoints: null,
  }
  let own = []
  try { own = readdirSync(join(PLUGIN_ROOT, 'agents')).filter((f) => f.endsWith('.md')) } catch { /* not a checkout */ }
  try { facts.shadowedAgents = readdirSync(join(cwd, '.claude/agents')).filter((f) => own.includes(f)) } catch { /* none */ }
  try {
    const files = readdirSync(join(cwd, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f))
    facts.workflows = files.length
    facts.prWorkflows = files.filter((f) => /^\s*pull_request(_target)?\s*:|\bon:\s*\[?[^\n\]]*\bpull_request\b/m.test(readFileSync(join(cwd, '.github/workflows', f), 'utf8'))).length
  } catch { facts.workflows = 0; facts.prWorkflows = 0 }
  facts.playwrightConfig = ['ts', 'js', 'mts', 'mjs', 'cjs'].some((e) => existsSync(join(cwd, `playwright.config.${e}`)))
  if (!gh) return facts
  const q = (args) => JSON.parse(run('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }))
  try { q(['repo', 'view', '--json', 'nameWithOwner']); facts.gh = true } catch { facts.gh = false; return facts }
  try {
    const runs = q(['run', 'list', '--event', 'pull_request', '--status', 'completed', '--limit', '30', '--json', 'startedAt,updatedAt'])
    const secs = runs.map((r) => (Date.parse(r.updatedAt) - Date.parse(r.startedAt)) / 1000).filter((n) => Number.isFinite(n) && n >= 0)
    facts.ciRuns = secs.length
    facts.ciSeconds = median(secs)
  } catch { /* no runs readable */ }
  try {
    const issues = q(['issue', 'list', '--state', 'open', '--limit', '200', '--json', 'number,body,labels'])
      .filter((i) => !(i.labels || []).some((l) => /^epic$/i.test(l.name)))
    facts.openIssues = issues.length
    facts.withPoints = issues.filter((i) => STORY_POINTS.test(i.body || '')).length
  } catch { /* issues unreadable */ }
  return facts
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`

export function assess(f) {
  const out = []
  const add = (level, text) => out.push({ level, text })
  const instr = f.claudeMd ?? f.agentsMd
  const name = f.claudeMd != null ? 'CLAUDE.md' : 'AGENTS.md'
  if (instr == null) add('WARN', 'No CLAUDE.md or AGENTS.md: every agent infers the build, test and lint commands and says so in its report. docs/templates/CLAUDE.md is a starting point.')
  else if (instr > INSTRUCTION_FILE_BUDGET) add('WARN', `${name} is ${kb(instr)}, over the ${kb(INSTRUCTION_FILE_BUDGET)} budget. It is injected into every dispatched agent and re-read on every turn; move detail into topic files it links to.`)
  else add('OK', `${name} is ${kb(instr)}, inside the ${kb(INSTRUCTION_FILE_BUDGET)} budget.`)
  if (f.deliveryMd == null) add('INFO', 'No .claude/delivery.md. That is fine; it is where gate commands, owner-only criteria and known traps go when CLAUDE.md should stay small (docs/templates/delivery.md).')
  else add('OK', `.claude/delivery.md is present (${kb(f.deliveryMd)}).`)
  if (f.shadowedAgents.length) add('WARN', `.claude/agents/ overrides plugin agent(s) ${f.shadowedAgents.join(', ')}: the workflow dispatches the project's copy, silently (docs/precedence-and-gotchas.md, 1).`)
  if (!f.workflows) add('WARN', 'No .github/workflows: there is no CI for a PR, so every run reports CI as not configured and rests on the local gate.')
  else if (!f.prWorkflows) add('WARN', `${f.workflows} workflow file(s), none triggered by pull_request: the implementer's CI wait finds no checks.`)
  else add('OK', `${f.prWorkflows} of ${f.workflows} workflow file(s) run on pull requests.`)
  if (f.gh === false) add('WARN', '`gh` cannot read this repository (not authenticated, or no GitHub remote): the pipeline cannot read issues or open PRs.')
  if (f.gh === null) add('INFO', 'GitHub checks skipped (--no-gh).')
  if (f.ciSeconds != null) {
    const waits = Math.max(1, Math.ceil((f.ciSeconds * 1000) / CI_WAIT_MS))
    add(waits > 8 ? 'WARN' : 'INFO', `Median PR CI run: ${Math.round(f.ciSeconds)} s over ${f.ciRuns} run(s), which is ${waits} bounded wait(s) of ${CI_WAIT_MS / 1000} s` +
      (waits > 8 ? '. That is past the 8 waits an implementer makes: CI will be reported as not verified. A faster PR gate would fix it.' : '.'))
  }
  if (f.openIssues != null) {
    if (!f.openIssues) add('INFO', 'No open issues (epics aside).')
    else {
      const share = f.withPoints / f.openIssues
      add(share < 0.7 ? 'WARN' : 'OK', `${f.withPoints} of ${f.openIssues} open issues carry a Story Points line (${Math.round(share * 100)}%).` +
        (share < 0.7 ? ' The rest take the full review on the session model whatever their size; add the line, pass --points, or run with --triage.' : ''))
    }
  }
  add('INFO', f.playwrightConfig ? 'A Playwright config is present: --e2e and the ui-vision agent have something to run against.' : 'No Playwright config at the repository root: --e2e adds nothing here unless a sub-package holds one.')
  return out
}

export const render = (lines) => lines.map((l) => `${l.level.padEnd(4)}  ${l.text}`).join('\n')

function main(argv) {
  const bad = argv.find((a) => !['--json', '--no-gh'].includes(a))
  if (bad) { console.error(`unknown option ${bad}\nusage: node scripts/doctor.mjs [--json] [--no-gh]`); return 2 }
  const facts = gather(process.cwd(), { gh: !argv.includes('--no-gh') })
  const lines = assess(facts)
  console.log(argv.includes('--json') ? JSON.stringify({ facts, lines }, null, 2) : render(lines))
  return 0
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
