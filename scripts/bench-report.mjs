#!/usr/bin/env node
//
// Report the pipeline-replay benchmark that scripts/bench-run.mjs recorded. Stdlib only,
// read-only: it reads the results tree and prints; it runs nothing.
//
//   node scripts/bench-report.mjs [bench/results] [--json]
//
// Layout read (written by bench-run.mjs):
//   <results>/<ref>/<scenario>/run-<n>/meta.json            ref, sha, scenario, wall time per call,
//                                                            and the --orchestrate-args the run was given
//   <results>/<ref>/<scenario>/run-<n>/claude-<k>.json       `claude -p --output-format json` output
//   <results>/<ref>/<scenario>/run-<n>/sessions/<id>/workflows/wf_*.json            workflow results
//   <results>/<ref>/<scenario>/run-<n>/sessions/<id>/subagents/workflows/wf_*/agent-*.jsonl (+ .meta.json)
//
// Per ref and scenario, averaged over runs: total subagent tokens (input + cache writes + cache
// reads + output), output tokens per phase, wall time, list-price cost, review findings by
// severity, fix cycles, and the scratch-repo isolation the run used. Then, per scenario issue, how
// many runs' first review drew a blocking finding and how many named the issue's planted defect
// (#98: the defect is described in meta.json, never to the agents). Then the same tokens split by
// type and phase, so a prompt-footprint change (cache writes and reads) can be told apart from
// an effort change (output). Then the behaviour checks, read from the transcripts, which pass only
// if every run passes:
//   #48  every FULL review ran at `high` effort
//   #49  the fix phase created no branch and no PR
//   #51  no agent read CLAUDE.md (it is already in context), and none asked the user a question
// and the highest turn count per agent type, which is what the agents' maxTurns are set from
// (#97; docs/benchmarks.md says how). A run given --orchestrate-args is reported as
// "<ref> [<args>]", apart from the same ref's plain run, with the implement effort each
// orchestrate batch recorded (#96).
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit']
const ORCH_PHASES = ['Implement', 'Review', 'Fix', 'Re-review']
const EPIC_PHASES = ['Research', 'Plan']
const TOKEN_TYPES = ['input', 'cacheWrite', 'cacheRead', 'output']

const isDir = (p) => existsSync(p) && statSync(p).isDirectory()
const ls = (p) => (isDir(p) ? readdirSync(p).sort() : [])
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

// What an agent did, from its transcript. Streamed blocks of one assistant message share its
// id, so turns and usage are counted per distinct message id (the last usage seen wins).
export function readTranscript(text) {
  const usage = new Map()
  const efforts = new Set()
  const tools = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d?.type !== 'assistant' || !d.message) continue
    const id = d.message.id || `line-${usage.size}`
    if (d.message.usage) usage.set(id, d.message.usage)
    else if (!usage.has(id)) usage.set(id, null)
    if (typeof d.effort === 'string') efforts.add(d.effort)
    for (const c of Array.isArray(d.message.content) ? d.message.content : []) {
      if (c?.type === 'tool_use') tools.push({ name: c.name, input: c.input || {} })
    }
  }
  const tokens = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  for (const u of usage.values()) {
    if (!u) continue
    tokens.input += num(u.input_tokens)
    tokens.cacheWrite += num(u.cache_creation_input_tokens)
    tokens.cacheRead += num(u.cache_read_input_tokens)
    tokens.output += num(u.output_tokens)
  }
  return { turns: usage.size, tokens, efforts: [...efforts].sort(), tools }
}

const bashOf = (t) => (t.name === 'Bash' && typeof t.input.command === 'string' ? t.input.command : '')
const CLAUDE_MD_READ = /(^|[\s/'"])CLAUDE\.md\b/
// A shell read starts a command (the start of the string or after ; & | or a subshell paren) and
// takes the file as an argument. Unanchored, prose in a heredoc ("head: 74 tests ... CLAUDE.md")
// matched. less and more are left out: they page, and an agent has no terminal to page in.
const SHELL_READ = /(?:^|[;&|(]\s*)(?:cat|head|tail|sed|awk|grep|bat)\s[^|;&\n]*\bCLAUDE\.md\b/
export const readsClaudeMd = (t) =>
  (t.name === 'Read' && typeof t.input.file_path === 'string' && /(^|\/)CLAUDE\.md$/.test(t.input.file_path))
  || (t.name === 'Bash' && SHELL_READ.test(bashOf(t)))
  || (t.name === 'Grep' && CLAUDE_MD_READ.test(String(t.input.path || t.input.pattern || '')))
export const asksUser = (t) => t.name === 'AskUserQuestion'
const NEW_BRANCH = /\bgit\s+(?:checkout\s+(?:-b|-B)|switch\s+(?:-c|-C|--create)|branch\s+(?!-)[\w./-]+|worktree\s+add\s+(?:[^\s;&|]+\s+)*?-b)\b|\bgh\s+pr\s+create\b/
export const createsBranchOrPr = (t) => NEW_BRANCH.test(bashOf(t))

// A planted defect is found when a finding's location names one of its files (inside the line
// range, when one is given), or its location or summary contains one of its keywords, ignoring case.
const parseLoc = (s) => {
  const m = String(s).trim().match(/^(.*?)(?::(\d+)(?:-(\d+))?)?$/)
  const from = m[2] ? Number(m[2]) : null
  return { file: m[1].replace(/^\.\//, ''), from, to: m[3] ? Number(m[3]) : from }
}
const sameFile = (a, b) => Boolean(a && b) && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`))
export function matchesPlanted(f, spec) {
  const text = `${f?.location ?? ''} ${f?.summary ?? ''}`.toLowerCase()
  if ((spec?.keywords || []).some((k) => k && text.includes(String(k).toLowerCase()))) return true
  const at = parseLoc(f?.location ?? '')
  return (spec?.locations || []).some((l) => {
    const want = parseLoc(l)
    if (!sameFile(at.file, want.file)) return false
    return want.from === null || (at.from !== null && at.from <= want.to && at.to >= want.from)
  })
}

// Per scenario issue (named from the calls bench-run recorded, else `#<number>`): did the first
// review block, and did a blocking finding name the issue's planted defect? A result without
// `review` (an older ref) still shows whether it blocked by whether a fix ran; null is unknown.
function reviewsOf(prs, calls) {
  const byNumber = new Map((Array.isArray(calls) ? calls : []).filter((c) => c?.issue && Number.isInteger(c.number)).map((c) => [c.number, c]))
  const seen = new Set()
  const out = prs.filter((p) => p?.issue != null).map((p) => {
    const call = byNumber.get(Number(p.issue))
    if (call) seen.add(call.number)
    const spec = call?.planted && typeof call.planted === 'object' ? call.planted : null
    const findings = Array.isArray(p.review?.findings) ? p.review.findings : null
    const blocking = typeof p.blockingFindings === 'boolean' ? p.blockingFindings
      : findings ? Boolean(p.review.blocking || findings.some((f) => f?.blocking))
        : p.reviewCompleted === false ? null
          : 'fix' in p ? p.fix != null : null
    const planted = spec && findings ? findings.some((f) => f?.blocking && matchesPlanted(f, spec)) : null
    return { issue: call?.issue ?? `#${p.issue}`, blocking, planted, hasPlanted: Boolean(spec) }
  })
  // A call whose issue never reached a reviewed PR still counts as a run, with nothing known.
  for (const c of byNumber.values()) if (!seen.has(c.number)) out.push({ issue: c.issue, blocking: null, planted: null, hasPlanted: Boolean(c.planted) })
  return out
}

function agentsOf(sessionDir) {
  const out = []
  const root = join(sessionDir, 'subagents', 'workflows')
  for (const wf of ls(root)) {
    for (const f of ls(join(root, wf)).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
      const meta = readJson(join(root, wf, f.replace(/\.jsonl$/, '.meta.json'))) || {}
      const t = readTranscript(readFileSync(join(root, wf, f), 'utf8'))
      out.push({ agentType: meta.agentType || 'unknown', label: meta.description || '', phase: meta.workflowPhase || 'unknown', model: meta.model || null, ...t })
    }
  }
  return out
}

function resultsOf(sessionDir) {
  return ls(join(sessionDir, 'workflows')).filter((f) => /^wf_.*\.json$/.test(f))
    .map((f) => readJson(join(sessionDir, 'workflows', f))).filter(Boolean)
    .map((w) => {
      let r = w.result
      if (typeof r === 'string') { try { r = JSON.parse(r) } catch { r = null } }
      return { workflowName: w.workflowName || null, durationMs: num(w.durationMs) || null, result: r }
    })
}

// A call that crashed, timed out or whose session could not be found contributes fewer tokens
// and vacuous checks, which would read as an improvement; so it is flagged.
const incompleteOf = (calls) => (Array.isArray(calls) ? calls.filter((c) => ('exit' in c && c.exit !== 0) || c.sessionFound === false).length : 0)
function epicFiledOf(calls) {
  const c = Array.isArray(calls) ? calls[0] : null
  return c && typeof c.issuesBefore === 'number' && typeof c.issuesAfter === 'number' ? c.issuesAfter > c.issuesBefore : null
}

export function analyseRun(runDir) {
  const meta = readJson(join(runDir, 'meta.json')) || {}
  const orchestrateArgs = typeof meta.orchestrateArgs === 'string' && meta.orchestrateArgs ? meta.orchestrateArgs.replace(/\s+/g, ' ').trim() : null
  const sessions = ls(join(runDir, 'sessions')).map((s) => join(runDir, 'sessions', s))
  const agents = sessions.flatMap(agentsOf)
  const results = sessions.flatMap(resultsOf)
  const claude = ls(runDir).filter((f) => /^claude-.*\.json$/.test(f)).map((f) => readJson(join(runDir, f))).filter(Boolean)
  const tokens = agents.reduce((n, a) => n + a.tokens.input + a.tokens.cacheWrite + a.tokens.cacheRead + a.tokens.output, 0)
  const outputByPhase = {}
  const tokensByPhase = {}
  for (const a of agents) {
    outputByPhase[a.phase] = (outputByPhase[a.phase] || 0) + a.tokens.output
    const t = (tokensByPhase[a.phase] ||= Object.fromEntries(TOKEN_TYPES.map((k) => [k, 0])))
    for (const k of TOKEN_TYPES) t[k] += a.tokens[k]
  }
  // Findings come from the workflow results (review + re-review), when they record them.
  const prs = results.flatMap((r) => (Array.isArray(r.result?.batches) ? r.result.batches : []).flatMap((b) => (Array.isArray(b?.prs) ? b.prs : [])))
  let findings = null
  for (const p of prs) {
    for (const k of ['review', 'rereview']) {
      const c = p?.findingCounts?.[k]
      if (!c || typeof c !== 'object') continue
      findings ||= Object.fromEntries(SEVERITIES.map((s) => [s, 0]))
      for (const s of SEVERITIES) findings[s] += num(c[s])
    }
  }
  // The implement effort each batch recorded (#96: a small-tier batch may run at medium).
  const efforts = [...new Set(results.flatMap((r) => (Array.isArray(r.result?.batches) ? r.result.batches : [])
    .map((b) => b?.implementEffort).filter((e) => typeof e === 'string')))].sort()
  const fullIssues = new Set(prs.filter((p) => p?.reviewScope === 'full').map((p) => String(p.issue)))
  const fullReviews = agents.filter((a) => a.phase === 'Review' && fullIssues.has(a.label.replace(/^review:/, '')))
  const fixAgents = agents.filter((a) => a.phase === 'Fix')
  const count = (pred, list = agents) => list.reduce((n, a) => n + a.tools.filter(pred).length, 0)
  const turnsByType = {}
  for (const a of agents) turnsByType[a.agentType] = Math.max(turnsByType[a.agentType] || 0, a.turns)
  return {
    ref: (meta.ref ?? basename(dirname(dirname(runDir)))) + (orchestrateArgs ? ` [${orchestrateArgs}]` : ''),
    orchestrateArgs,
    implementEfforts: efforts,
    sha: meta.sha ?? null,
    scenario: meta.scenario ?? basename(dirname(runDir)),
    run: basename(runDir),
    wallMs: Array.isArray(meta.calls) ? meta.calls.reduce((n, c) => n + num(c.wallMs), 0) : null,
    costUsd: claude.length ? claude.reduce((n, c) => n + num(c.total_cost_usd), 0) : null,
    agents: agents.length,
    tokens,
    outputByPhase,
    tokensByPhase,
    findings,
    fixCycles: fixAgents.length,
    reviews: reviewsOf(prs, meta.calls),
    // The planner's reply is free text, so a reply proves nothing: an epic was filed only if the
    // scratch repository gained issues across the call (counted by bench-run.mjs). Unknown if
    // the counts were not recorded.
    epicFiled: meta.scenario === 'plan-epic' ? epicFiledOf(meta.calls) : null,
    incomplete: incompleteOf(meta.calls),
    // How bench-run.mjs kept this run from seeing an earlier ref's or run's issues and PRs
    // (`reset` or `repo-per-ref`); null for results recorded before it isolated runs.
    isolation: typeof meta.isolation?.mode === 'string' ? meta.isolation.mode : null,
    checks: {
      fullReviewHigh: fullReviews.length ? fullReviews.every((a) => a.efforts.length > 0 && a.efforts.every((e) => e === 'high')) : null,
      fixNoNewBranchOrPr: fixAgents.length ? count(createsBranchOrPr, fixAgents) === 0 : null,
      noClaudeMdRead: agents.length ? count(readsClaudeMd) === 0 : null,
      noAskUser: agents.length ? count(asksUser) === 0 : null,
    },
    counts: { claudeMdReads: count(readsClaudeMd), askUser: count(asksUser), fixBranchOrPr: count(createsBranchOrPr, fixAgents), fullReviews: fullReviews.length },
    turnsByType,
  }
}

export function collect(dir) {
  const runs = []
  for (const ref of ls(dir)) {
    for (const scenario of ls(join(dir, ref))) {
      for (const run of ls(join(dir, ref, scenario)).filter((r) => /^run-\d+$/.test(r))) runs.push(analyseRun(join(dir, ref, scenario, run)))
    }
  }
  return runs
}

// Mean over runs for numbers; a check passes only if it passed in every run where it applied.
export function aggregate(runs) {
  const groups = new Map()
  for (const r of runs) {
    const k = `${r.ref}\u0000${r.scenario}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  return [...groups.values()].map((rs) => {
    const nums = (f) => rs.map(f).filter((v) => typeof v === 'number')
    const ORDER = [...ORCH_PHASES, ...EPIC_PHASES]
    const rank = (p) => (ORDER.includes(p) ? ORDER.indexOf(p) : ORDER.length)
    const phases = [...new Set(rs.flatMap((r) => Object.keys(r.outputByPhase)))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    const checks = {}
    for (const c of Object.keys(rs[0].checks)) {
      const vals = rs.map((r) => r.checks[c]).filter((v) => v !== null)
      checks[c] = vals.length ? vals.every(Boolean) : null
    }
    const turns = {}
    for (const r of rs) for (const [t, n] of Object.entries(r.turnsByType)) turns[t] = Math.max(turns[t] || 0, n)
    const withFindings = rs.filter((r) => r.findings)
    const outcomes = new Map()
    for (const v of rs.flatMap((r) => r.reviews || [])) {
      const o = outcomes.get(v.issue) || { issue: v.issue, runs: 0, reviewed: 0, blocking: 0, planted: false, plantedKnown: 0, plantedHits: 0 }
      o.runs++
      if (v.blocking !== null) o.reviewed++
      if (v.blocking) o.blocking++
      if (v.hasPlanted) o.planted = true
      if (v.planted !== null) { o.plantedKnown++; if (v.planted) o.plantedHits++ }
      outcomes.set(v.issue, o)
    }
    return {
      ref: rs[0].ref, sha: rs[0].sha, scenario: rs[0].scenario, runs: rs.length,
      tokens: mean(nums((r) => r.tokens)),
      outputByPhase: Object.fromEntries(phases.map((p) => [p, mean(rs.map((r) => r.outputByPhase[p] || 0))])),
      tokensByPhase: Object.fromEntries(phases.map((p) => [p, Object.fromEntries(TOKEN_TYPES.map((k) => [k, mean(rs.map((r) => r.tokensByPhase[p]?.[k] || 0))]))])),
      wallMs: mean(nums((r) => r.wallMs)),
      costUsd: mean(nums((r) => r.costUsd)),
      findings: withFindings.length ? Object.fromEntries(SEVERITIES.map((s) => [s, mean(withFindings.map((r) => r.findings[s]))])) : null,
      fixCycles: mean(rs.map((r) => r.fixCycles)),
      fixRan: rs.some((r) => r.fixCycles > 0),
      reviewOutcomes: [...outcomes.values()],
      isolation: [...new Set(rs.map((r) => r.isolation ?? 'none'))].sort().join(', '),
      implementEffort: [...new Set(rs.flatMap((r) => r.implementEfforts))].sort().join(', ') || null,
      epicFiled: rs[0].scenario === 'plan-epic' ? (rs.some((r) => r.epicFiled === false) ? false : rs.every((r) => r.epicFiled === true) ? true : null) : null,
      incompleteRuns: rs.filter((r) => r.incomplete > 0).length,
      checks,
      maxTurns: turns,
    }
  })
}

const fmt = (n, d = 0) => (n == null ? 'n/a' : Number(n.toFixed(d)).toLocaleString('en-US'))
const ck = (v) => (v === null || v === undefined ? 'n/a' : v ? 'PASS' : 'FAIL')
function table(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)))
  return [head, ...rows].map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd()).join('\n')
}

export function render(groups) {
  if (!groups.length) return 'no benchmark runs found'
  const out = []
  const phasesFor = (g) => (g.scenario === 'plan-epic' ? EPIC_PHASES : ORCH_PHASES)
  out.push(table(['ref', 'scenario', 'runs', 'subagent tokens', 'output by phase', 'wall time', 'costUsd', 'findings c/h/m/l/n', 'fix cycles', 'epic filed', 'isolation'],
    groups.map((g) => [g.ref, g.scenario, g.runs, fmt(g.tokens),
      phasesFor(g).map((p) => `${p} ${fmt(g.outputByPhase[p] ?? 0)}`).join(', '),
      g.wallMs == null ? 'n/a' : `${fmt(g.wallMs / 60000, 1)} min`, g.costUsd == null ? 'n/a' : `$${g.costUsd.toFixed(2)}`,
      g.findings ? SEVERITIES.map((s) => fmt(g.findings[s], 1)).join('/') : 'n/a', fmt(g.fixCycles, 1),
      g.scenario !== 'plan-epic' ? '-' : g.epicFiled === null ? 'n/a' : g.epicFiled ? 'yes' : 'NO', g.isolation])))
  out.push('')
  const rate = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : 'n/a')
  const outcomeRows = groups.flatMap((g) => g.reviewOutcomes.map((o) => [g.ref, g.scenario, o.issue, o.runs, rate(o.blocking, o.reviewed),
    o.planted ? rate(o.plantedHits, o.plantedKnown) : '-']))
  if (outcomeRows.length) {
    out.push('Review outcome per scenario issue (blocking: runs whose first review drew a blocking finding, of runs reviewed; planted defect: runs in which a blocking finding named it, of runs whose findings were recorded; -: no planted defect)')
    out.push(table(['ref', 'scenario', 'issue', 'runs', 'blocking', 'planted defect'], outcomeRows))
    out.push('')
  }
  out.push('Subagent tokens by type and phase (cache write and read move with the prompt footprint, output with effort)')
  const sum = (ts) => Object.fromEntries(TOKEN_TYPES.map((k) => [k, ts.reduce((n, t) => n + t[k], 0)]))
  out.push(table(['ref', 'scenario', 'phase', 'input', 'cache write', 'cache read', 'output'],
    groups.flatMap((g) => [...Object.entries(g.tokensByPhase), ['all', sum(Object.values(g.tokensByPhase))]]
      .map(([p, t]) => [g.ref, g.scenario, p, ...TOKEN_TYPES.map((k) => fmt(t[k]))]))))
  out.push('')
  const orch = groups.filter((g) => g.scenario === 'orchestrate')
  if (orch.length) {
    out.push('Implement effort recorded by the orchestrate results (#96: --small-effort; small and non-small issues can differ)')
    out.push(table(['ref', 'scenario', 'implement effort'], orch.map((g) => [g.ref, g.scenario, g.implementEffort ?? 'n/a'])))
    out.push('')
  }
  out.push(table(['ref', 'scenario', '#48 full review at high', '#49 fix: no new branch/PR', '#51 no CLAUDE.md read', '#51 no ask-user'],
    groups.map((g) => [g.ref, g.scenario, ck(g.checks.fullReviewHigh), ck(g.checks.fixNoNewBranchOrPr), ck(g.checks.noClaudeMdRead), ck(g.checks.noAskUser)])))
  out.push('')
  out.push('Highest turn count per agent type (#97: maxTurns is set from this with headroom; see docs/benchmarks.md)')
  const types = [...new Set(groups.flatMap((g) => Object.keys(g.maxTurns)))].sort()
  out.push(table(['ref', 'scenario', ...types], groups.map((g) => [g.ref, g.scenario, ...types.map((t) => g.maxTurns[t] ?? '-')])))
  out.push('')
  for (const g of groups.filter((x) => x.incompleteRuns)) {
    out.push(`WARNING: ${g.ref} / ${g.scenario}: ${g.incompleteRuns} of ${g.runs} run(s) INCOMPLETE (a call exited non-zero, timed out, or its session was not found). Its numbers are not comparable.`)
  }
  for (const g of groups.filter((x) => x.scenario === 'orchestrate' && !x.fixRan)) {
    out.push(`WARNING: ${g.ref} / ${g.scenario}: no run exercised the Fix phase (no review drew a blocking finding), so fix, re-review and #49 went unchecked.`)
  }
  for (const g of groups.filter((x) => x.isolation.split(', ').includes('none'))) {
    out.push(`WARNING: ${g.ref} / ${g.scenario}: no scratch-repo isolation recorded (results from before bench-run reset the repo per step); it may have seen issues and PRs an earlier ref or run left behind.`)
  }
  out.push('Numbers are means over runs; a check passes only if it passed in every run it applied to (n/a: nothing to check).')
  return out.join('\n')
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const rest = args.filter((a) => a !== '--json')
  if (rest.some((a) => a.startsWith('-')) || rest.length > 1) {
    console.error('usage: node scripts/bench-report.mjs [results-dir] [--json]')
    process.exit(2)
  }
  const dir = resolve(rest[0] || join(ROOT, 'bench', 'results'))
  if (!isDir(dir)) { console.error(`no results directory at ${dir}; run scripts/bench-run.mjs first`); process.exit(2) }
  const runs = collect(dir)
  const groups = aggregate(runs)
  console.log(asJson ? JSON.stringify({ runs, groups }, null, 2) : render(groups))
}
