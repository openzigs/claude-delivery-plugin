#!/usr/bin/env node
//
// The facts a fresh session needs to pick up delivery work: open pull requests with the last
// review's recommendation and CI state, open epics, and what the most recent saved
// /delivery:orchestrate runs left unfinished. Stdlib only, read-only: it runs read-only `gh`
// queries, opens saved run results for reading, and writes only to stdout and stderr.
//
//   node scripts/handoff.mjs [--json] [--no-gh] [--runs N]
//
// It prints Markdown. The handoff skill puts that under "State" in the note it writes and adds
// what only the conversation knows (decisions, the next step). Nothing here is a judgement: a PR
// is listed with what GitHub and the saved result say about it, in their words.
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unwrap, discoverFiles, configDir } from './cost-report.mjs'

const one = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
// The line a delivery review opens with. Read from the newest review that has one.
export const recommendationOf = (reviews) => {
  for (const r of [...(Array.isArray(reviews) ? reviews : [])].reverse()) {
    const m = /^\s*Recommendation:\s*(.+)$/m.exec(r?.body || '')
    if (m) return one(m[1], 120)
  }
  return null
}
export const ciOf = (rollup) => {
  const c = (Array.isArray(rollup) ? rollup : []).map((x) => String(x?.conclusion || x?.state || x?.status || '').toUpperCase())
  if (!c.length) return 'no checks'
  if (c.some((x) => /FAIL|ERROR|TIMED_OUT|CANCEL/.test(x))) return 'failing'
  if (c.some((x) => !x || /PENDING|QUEUED|IN_PROGRESS|EXPECTED/.test(x))) return 'pending'
  return 'passing'
}

// What the newest `runs` saved orchestrate results left open, by PR and by issue.
export function unfinished(results) {
  const out = { awaitingOwner: [], stillBlocking: [], notReviewed: [], notImplemented: [] }
  const seen = new Set()
  const add = (k, v) => { const key = `${k}:${v}`; if (!seen.has(key)) { seen.add(key); out[k].push(v) } }
  for (const data of results) {
    if (!data || !Array.isArray(data.batches)) continue
    for (const b of data.batches) {
      for (const n of Array.isArray(b?.notImplemented) ? b.notImplemented : []) add('notImplemented', n)
      for (const n of Array.isArray(b?.noPr) ? b.noPr : []) if (n != null) add('notImplemented', n)
      for (const p of Array.isArray(b?.prs) ? b.prs : []) {
        if (!p || !Number.isInteger(p.pr)) continue
        if (p.reviewCompleted === false) add('notReviewed', p.pr)
        else if (Array.isArray(p.awaiting) && p.awaiting.length && !p.fix) add('awaitingOwner', p.pr)
        else if (p.stillBlocking) add('stillBlocking', p.pr)
      }
    }
  }
  return out
}

// A checkout holds one unnamed note (.claude/handoff.md) and any number of named ones
// (.claude/handoff-<name>.md), one per workstream, so two sessions on different work do not
// overwrite each other's decisions.
export const NOTE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
export const noteFile = (name) => (name ? `.claude/handoff-${name}.md` : '.claude/handoff.md')
export function notesIn(cwd) {
  let names = []
  try { names = readdirSync(join(cwd, '.claude')) } catch { return [] }
  return names.map((f) => /^handoff(?:-([a-z0-9][a-z0-9-]{0,40}))?\.md$/.exec(f)).filter(Boolean).map((m) => {
    let written = null
    try { written = statSync(join(cwd, '.claude', m[0])).mtime.toISOString().slice(0, 10) } catch { /* vanished */ }
    return { name: m[1] ?? null, file: `.claude/${m[0]}`, written }
  }).sort((a, b) => (a.name ?? '') < (b.name ?? '') ? -1 : 1)
}

// Whether git ignores the notes here. `git check-ignore -q` exits 0 when it does; anything else
// (not ignored, or not a repository) reads as not ignored, which is the safe thing to say.
export const ignoredByGit = (cwd, run = execFileSync) => {
  try { run('git', ['check-ignore', '-q', '.claude/handoff.md'], { cwd, stdio: 'ignore' }); return true } catch { return false }
}

export function gather(cwd, { gh = true, runs = 10, run = execFileSync, config = configDir(), ignored = ignoredByGit } = {}) {
  const facts = { gh: null, repo: null, prs: [], epics: [], runsRead: 0, unfinished: unfinished([]), notes: notesIn(cwd), notesIgnored: ignored(cwd) }
  const saved = []
  for (const f of discoverFiles(config, cwd).files) {
    try { const u = unwrap(JSON.parse(readFileSync(f, 'utf8'))); if (!u.skip && Array.isArray(u.data?.batches)) saved.push({ data: u.data, time: u.startTime ?? 0 }) } catch { /* not a result */ }
  }
  const newest = saved.sort((a, b) => a.time - b.time).slice(-runs)
  facts.runsRead = newest.length
  facts.unfinished = unfinished(newest.map((r) => r.data))
  if (!gh) return facts
  const q = (args) => JSON.parse(run('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }))
  try { facts.repo = q(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner; facts.gh = true } catch { facts.gh = false; return facts }
  try {
    facts.prs = q(['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,isDraft,reviews,statusCheckRollup,updatedAt'])
      .map((p) => ({ number: p.number, title: one(p.title, 90), branch: p.headRefName, draft: Boolean(p.isDraft), ci: ciOf(p.statusCheckRollup), recommendation: recommendationOf(p.reviews), updated: String(p.updatedAt || '').slice(0, 10) }))
      .sort((a, b) => a.number - b.number)
  } catch { /* PRs unreadable */ }
  try {
    facts.epics = q(['issue', 'list', '--state', 'open', '--label', 'epic', '--limit', '30', '--json', 'number,title']).map((i) => ({ number: i.number, title: one(i.title, 90) })).sort((a, b) => a.number - b.number)
  } catch { /* no epic label, or issues unreadable */ }
  return facts
}

const nums = (a, sign = '#') => (a.length ? a.map((n) => `${sign}${n}`).join(', ') : 'none')

export function render(f, today = new Date().toISOString().slice(0, 10)) {
  const out = [`### State on ${today}${f.repo ? ` — ${f.repo}` : ''}`, '']
  if (f.gh === false) out.push('`gh` could not read this repository, so the pull request and epic lists are missing.', '')
  if (f.gh === null) out.push('GitHub was not queried (--no-gh).', '')
  if (f.gh) {
    out.push(`**Open pull requests (${f.prs.length})**`, '')
    if (!f.prs.length) out.push('- none')
    for (const p of f.prs) {
      out.push(`- #${p.number} ${p.title}${p.draft ? ' (draft)' : ''} — branch \`${p.branch}\`, CI ${p.ci}, ${p.recommendation ? `last review: ${p.recommendation}` : 'no delivery review yet'}, updated ${p.updated}`)
    }
    out.push('', `**Open epics (${f.epics.length})**`, '')
    out.push(...(f.epics.length ? f.epics.map((e) => `- #${e.number} ${e.title}`) : ['- none']))
    out.push('')
  }
  const u = f.unfinished
  out.push(`**Left open by the last ${f.runsRead} saved orchestrate run(s)**`, '')
  if (!f.runsRead) out.push('- no saved runs found for this project')
  else {
    out.push(`- Waiting on the owner or on CI, no fix ran: ${nums(u.awaitingOwner)}`)
    out.push(`- Still blocking after the re-review: ${nums(u.stillBlocking)}`)
    out.push(`- Review never returned: ${nums(u.notReviewed)}`)
    out.push(`- Issues not implemented or with no PR: ${nums(u.notImplemented)}`)
    const again = [...u.stillBlocking, ...u.notReviewed]
    if (again.length) out.push('', `To take those back through review once what was yours is cleared: \`/delivery:orchestrate --pr ${again.join(' ')}\`. A PR listed above may have been merged or closed since; the open pull request list is the current truth.`)
  }
  const notes = Array.isArray(f.notes) ? f.notes : []
  out.push('', `**Handoff notes in this checkout (${notes.length})**`, '')
  out.push(...(notes.length ? notes.map((n) => `- ${n.name ?? '(unnamed)'} — \`${n.file}\`, written ${n.written ?? 'unknown'}`) : ['- none']))
  if (f.notesIgnored === false) out.push('', 'Git does not ignore `.claude/handoff*.md` here. A note is working state: add that pattern to `.gitignore` unless the team shares notes.')
  return out.join('\n')
}

function main(argv) {
  let runs = 10
  const flags = new Set()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json' || a === '--no-gh') flags.add(a)
    else if (a === '--runs') { runs = Number(argv[++i]); if (!Number.isInteger(runs) || runs < 1) { console.error('--runs needs a positive integer'); return 2 } }
    else { console.error(`unknown option ${a}\nusage: node scripts/handoff.mjs [--json] [--no-gh] [--runs N]`); return 2 }
  }
  const facts = gather(process.cwd(), { gh: !flags.has('--no-gh'), runs })
  console.log(flags.has('--json') ? JSON.stringify(facts, null, 2) : render(facts))
  return 0
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2))
}
