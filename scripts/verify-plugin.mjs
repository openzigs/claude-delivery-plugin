#!/usr/bin/env node
//
// Structural verification for this plugin. Stdlib only, no dependencies.
//
//   node scripts/verify-plugin.mjs
//
// Checks, in order:
//   1. plugin.json is valid JSON with the required fields
//   2. every agent's frontmatter parses, has name + description, uses only
//      supported fields, and has a `name` matching its filename stem
//   3. every Agent(...) reference is namespaced and resolves to a real agent
//      and every `skills:` entry is namespaced, names a real skill directory,
//      and code-issue / code-review declare their own
//   4. every skill lives in its own directory with a SKILL.md whose `name`
//      matches that directory
//   5. every workflow parses as JavaScript
//   6. every workflow's `meta` is a PURE LITERAL -- the runtime reads it without
//      executing the module, so a variable, a call, a template interpolation or
//      even a `+` concatenation is rejected
//   7. every workflow body actually runs, against stubbed agent/phase/log/parallel, and
//      produces the intended phase order -- including the conditional branches,
//      which are driven by the review's structured output
//   8. scripts/cost-report.mjs reports the synthetic result fixtures by its rules,
//      read-only and with node: builtins only, and --discover finds exactly the runs
//      in a synthetic Claude Code config tree, keeps the newest with --last when a run
//      has no start time, and says what --since dropped
//   9. the cost-report skill only runs that script -- each command line is exactly the
//      call plus quoted paths and flags, nothing chained, piped or redirected -- and shows
//      metrics only; the skill count stated in plugin.json, marketplace.json, README.md and
//      docs/installation.md is the number of skills/ directories holding a SKILL.md; the
//      README's Skills section names every skill; the README names every /delivery:*
//      command and every flag cost-report.mjs accepts; and docs/usage.md's "Reading the cost
//      of a run" links "What the result measures" and repeats its caveats
//  10. the review eval suite has the 12 original and 10+ harder seeded cases (every category),
//      clean controls with 2+ decoys, a control and the batch-review comparison; each case's
//      prompt is generated from the workflow and dispatches delivery:code-review on a scaffolded
//      fixture repository; each grader is proven able to fail on a canned reply, including one
//      naming a different defect; every case is mirrored at FULL scope under evals/full/; and
//      eval-run.mjs / eval-tiers.mjs run the matrix and report recall with its spread, invalid
//      runs, the batch criterion and the confidence calibration
//  11. scripts/footprint.mjs measures every dispatch, and the code-issue and code-review
//      dispatches stay under their stored byte ceiling
//
// It exists because every one of those failures is silent at runtime.
import { readFileSync, readdirSync, existsSync, statSync, rmSync, mkdirSync, mkdtempSync, symlinkSync, copyFileSync, cpSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, basename, dirname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (m) => console.log(`  PASS  ${m}`)
const bad = (m) => { fails++; console.log(`  FAIL  ${m}`) }
const skip = (m) => console.log(`  SKIP  ${m}`)

// The skills under `root`: directories holding a SKILL.md, by name. A stray file
// such as a gitignored skills/.DS_Store is not a skill and is not counted.
const skillDirsIn = (root) => readdirSync(join(root, 'skills'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(root, 'skills', e.name, 'SKILL.md'))).map((e) => e.name).sort()
const SKILLS = skillDirsIn(ROOT)

// The one unattended-run rule (#51). Every agent a workflow can dispatch carries it word for
// word, and so do the plan-epic prompts, so no dispatched run stalls on a question.
const UNATTENDED = '**Unattended runs.** When a workflow or another agent dispatched you, no user is present: ' +
  'never stop to ask a question or wait for a reply. Where a step says to ask, confirm or offer a choice, ' +
  'decide from the request, the issue and the repository, record the decision and why in your report, and ' +
  'carry on. Those steps apply only when a user invoked you interactively.'
const squash = (t) => t.replace(/\s+/g, ' ')

// ---------------------------------------------------------------- plugin.json
console.log('\n== .claude-plugin/plugin.json ==')
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'))
for (const f of ['name', 'version', 'description', 'author']) {
  manifest[f] ? ok(`has ${f}`) : bad(`missing ${f}`)
}
manifest.name === 'delivery' ? ok('name is "delivery"') : bad(`name is ${manifest.name}`)
// A minor or major release carries its change note in the README (#64), so a version bump
// cannot ship without saying what changed for users.
{
  const [maj, min] = String(manifest.version).split('.')
  const note = new RegExp(`^### What changed in ${maj}\\.${min}\\.0$`, 'm')
  note.test(readFileSync(join(ROOT, 'README.md'), 'utf8'))
    ? ok(`README.md has a "What changed in ${maj}.${min}.0" note for version ${manifest.version}`)
    : bad(`README.md has no "### What changed in ${maj}.${min}.0" note for version ${manifest.version}`)
}

// -------------------------------------------------------------------- agents
console.log('\n== agents/ ==')
const agentFiles = readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).sort()
const agentNames = new Set()

// Minimal YAML frontmatter reader: top-level `key: value` only, which is all the
// agent schema uses. Also verifies the block is well-formed YAML-ish (no tabs,
// every non-continuation line is `key: value`).
function frontmatter(src, file) {
  const lines = src.split('\n')
  if (lines[0] !== '---') { bad(`${file}: does not start with ---`); return null }
  const end = lines.indexOf('---', 1)
  if (end === -1) { bad(`${file}: unterminated frontmatter`); return null }
  const out = {}
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || /^#/.test(line)) continue  // blank, or a YAML full-line comment
    if (line.includes('\t')) { bad(`${file}: tab in frontmatter line ${i + 1}`); return null }
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line)
    if (!m) { bad(`${file}: unparseable frontmatter line ${i + 1}: ${line}`); return null }
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    out[m[1]] = v
  }
  return out
}

const KNOWN = new Set(['name', 'description', 'tools', 'disallowedTools', 'model',
  'effort', 'color', 'skills', 'permissionMode', 'maxTurns', 'initialPrompt'])

for (const file of agentFiles) {
  const stem = basename(file, '.md')
  const fm = frontmatter(readFileSync(join(ROOT, 'agents', file), 'utf8'), file)
  if (!fm) continue
  agentNames.add(stem)
  if (!fm.name) bad(`${file}: no name`)
  else if (fm.name !== stem) bad(`${file}: name "${fm.name}" != filename stem "${stem}"`)
  else if (!/^[a-z][a-z0-9-]*$/.test(fm.name)) bad(`${file}: name not lowercase/hyphen`)
  else ok(`${file}: name ok`)
  if (!fm.description) bad(`${file}: no description`)
  const unknown = Object.keys(fm).filter((k) => !KNOWN.has(k))
  if (unknown.length) bad(`${file}: unsupported frontmatter field(s): ${unknown.join(', ')}`)
}

// maxTurns guards (#58): a runaway research, browser or review agent stops at a ceiling
// and returns partial output. Only these three set it, and cacheTtl stays at its default
// everywhere (#13).
{
  const MAX_TURNS = ['research', 'ui-vision', 'code-review']
  const turns = Object.fromEntries(agentFiles.map((f) => [basename(f, '.md'), frontmatter(readFileSync(join(ROOT, 'agents', f), 'utf8'), f)?.maxTurns]))
  const bad3 = MAX_TURNS.filter((a) => !/^[1-9]\d*$/.test(turns[a] ?? ''))
  ;(bad3.length === 0 ? ok : bad)(`research, ui-vision and code-review each set maxTurns to a positive integer${bad3.length ? ` (missing or invalid: ${bad3.map((a) => `${a}=${turns[a]}`).join(', ')})` : ` (${MAX_TURNS.map((a) => `${a} ${turns[a]}`).join(', ')})`}`)
  const others = Object.keys(turns).filter((a) => !MAX_TURNS.includes(a) && turns[a] !== undefined)
  ;(others.length === 0 ? ok : bad)(`no other agent sets maxTurns${others.length ? ` (found on ${others.join(', ')})` : ''}`)
  // #97: each ceiling's frontmatter comment states its evidence -- the bench replay it read
  // and the highest turn count observed there, or that there is no data yet -- not a stale
  // "provisional" note.
  const note = (a) => { const l = readFileSync(join(ROOT, 'agents', `${a}.md`), 'utf8').split('\n'); return l.slice(1, l.indexOf('---', 1)).filter((x) => /^#/.test(x)).join(' ') }
  const unsourced = MAX_TURNS.filter((a) => { const n = note(a); return /provisional/i.test(n) || !/bench replay on #\d+/.test(n) || !/highest observed \d+|no data yet/i.test(n) })
  ;(unsourced.length === 0 ? ok : bad)(`each maxTurns comment names its bench replay and the highest observed turns, or says there is no data yet${unsourced.length ? ` (not on ${unsourced.join(', ')})` : ''}`)
  const ttl = [...agentFiles.map((f) => `agents/${f}`), ...SKILLS.map((d) => `skills/${d}/SKILL.md`), '.claude-plugin/plugin.json',
    ...readdirSync(join(ROOT, 'workflows')).map((f) => `workflows/${f}`)].filter((f) => /cacheTtl/.test(readFileSync(join(ROOT, f), 'utf8')))
  ;(ttl.length === 0 ? ok : bad)(`cacheTtl is not set anywhere${ttl.length ? ` (found in ${ttl.join(', ')})` : ''}`)
}

// The orchestrator agent is a thin pointer to /delivery:orchestrate (#60): every reference to
// it in skills, docs and the README also names the command, and the agent lists no phase the
// workflow does not run.
{
  const walkMd = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkMd(join(d, e.name)) : e.name.endsWith('.md') ? [join(d, e.name)] : [])
  const stale = [...walkMd('skills'), ...walkMd('docs'), 'README.md'].flatMap((f) => readFileSync(join(ROOT, f), 'utf8').split('\n')
    .map((l, i) => [f, i + 1, l]).filter(([, , l]) => l.includes('delivery:orchestrator') && !l.includes('/delivery:orchestrate')))
  ;(stale.length === 0 ? ok : bad)(`every line naming delivery:orchestrator in skills, docs and README also names /delivery:orchestrate${stale.length ? ` (${stale.map(([f, n]) => `${f}:${n}`).join(', ')})` : ''}`)
  const orch = readFileSync(join(ROOT, 'agents/orchestrator.md'), 'utf8')
  const wfSrc = readFileSync(join(ROOT, 'workflows/orchestrate.js'), 'utf8')
  const wfPhases = [...extractMetaPhases(wfSrc)]
  const agentPhases = [...orch.matchAll(/^\| \d+ \| ([^|]+?) \|/gm)].map((m) => m[1].trim())
  const extra = agentPhases.filter((p) => !wfPhases.includes(p))
  ;(agentPhases.length > 0 && extra.length === 0 && orch.includes('/delivery:orchestrate') ? ok : bad)(
    `agents/orchestrator.md points at /delivery:orchestrate and lists only phases the workflow runs (${agentPhases.join(', ')}${extra.length ? `; not in the workflow: ${extra.join(', ')}` : ''})`)
}

// An instruction must be something the agent can do (#61): a skill or agent body may tell
// its agent to hand off to, call or dispatch only an agent in that agent's Agent(...)
// allowlist; anything else is a recommendation the agent reports.
{
  const SKILL_AGENT = { 'code-issue': 'code-issue', 'code-review': 'code-review', 'ui-vision': 'ui-vision', 'e2e-test': 'e2e-test',
    'epic-planner': 'code-planner', 'research-gather': 'research' }
  const DISPATCH = /\b(hands? (?:it |the work |the findings |them )?(?:off |over )?to|call|dispatch(?:es|ing)?|invoke|delegate to|run)\s+(?:the\s+)?\*{0,2}`delivery:([a-z-]+)`/gi
  const LOOSE = /\b(hand\w*(?: [\w`]+){0,3}? to|hand-?off|send\w*|pass\w*|rout\w+|forward\w*|call|dispatch\w*|invoke|delegat\w+ to|run)\b[^.;\n]{0,80}?(?<![/:\w-])(?:delivery:)?(code-issue|code-review|e2e-test|ui-vision|code-planner|research-gather)(?![\w-])/gi
  const impossible = []
  for (const [skill, agentName] of Object.entries(SKILL_AGENT)) {
    const agentSrc = readFileSync(join(ROOT, 'agents', `${agentName}.md`), 'utf8')
    const allow = ((/Agent\(([^)]*)\)/.exec(frontmatter(agentSrc, `${agentName}.md`)?.tools || '') || [])[1] || '')
      .split(',').map((x) => x.trim().replace(/^delivery:/, '')).filter(Boolean)
    const text = squash([agentSrc, ...readdirSync(join(ROOT, 'skills', skill)).filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(ROOT, 'skills', skill, f), 'utf8'))].join('\n'))
    for (const m of text.matchAll(DISPATCH)) if (!allow.includes(m[2])) impossible.push(`${agentName} (skill ${skill}): "${m[0]}"`)
    // Any verb of sending work, followed within one clause by another agent's name (with or
    // without the delivery: prefix), is the same instruction in other words.
    for (const m of text.matchAll(LOOSE)) if (m[2] !== agentName && !allow.includes(m[2])) impossible.push(`${agentName} (skill ${skill}): "${m[0]}"`)
  }
  ;(impossible.length === 0 ? ok : bad)(`no skill or agent tells its agent to dispatch an agent outside its Agent(...) allowlist${impossible.length ? ` (${impossible.join('; ')})` : ''}`)
  // #62: an agent with no web tools is not told to use them -- no WebFetch/WebSearch, no link
  // to follow, no "check the real documentation" -- in its body or its skill's files.
  const webless = []
  for (const [skill, agentName] of Object.entries(SKILL_AGENT)) {
    const agentSrc = readFileSync(join(ROOT, 'agents', `${agentName}.md`), 'utf8')
    if (/\bWeb(Fetch|Search)\b/.test(frontmatter(agentSrc, `${agentName}.md`)?.tools || '')) continue
    for (const f of [`agents/${agentName}.md`, ...readdirSync(join(ROOT, 'skills', skill)).filter((x) => x.endsWith('.md')).map((x) => `skills/${skill}/${x}`)]) {
      const t = readFileSync(join(ROOT, f), 'utf8')
      if (/\bWeb(Fetch|Search)\b|\]\(https?:\/\/|against (the )?(real|official|vendor'?s?) documentation/i.test(t)) webless.push(f)
    }
  }
  ;(webless.length === 0 ? ok : bad)(`no agent without WebFetch/WebSearch, or its skill, is told to use the web${webless.length ? ` (${webless.join(', ')})` : ''}`)
  const texts = [...agentFiles.map((f) => `agents/${f}`), ...SKILLS.flatMap((d) => readdirSync(join(ROOT, 'skills', d)).filter((f) => f.endsWith('.md')).map((f) => `skills/${d}/${f}`))]
  const hits = (re) => texts.filter((f) => re.test(readFileSync(join(ROOT, f), 'utf8')))
  const stalePw = hits(/browser_go_(back|forward)|browser_navigate_forward/)
  ;(stalePw.length === 0 ? ok : bad)(`no agent or skill names a Playwright MCP tool that does not exist (browser_go_back/forward, browser_navigate_forward)${stalePw.length ? ` (${stalePw.join(', ')})` : ''}`)
  const noTool = hits(/\bTodoWrite\b|execution subagent/)
  ;(noTool.length === 0 ? ok : bad)(`no agent or skill relies on TodoWrite or an "execution subagent" no agent has${noTool.length ? ` (${noTool.join(', ')})` : ''}`)
  const ciSrc = readFileSync(join(ROOT, 'skills/code-issue/SKILL.md'), 'utf8')
  const wt = ciSrc.slice(ciSrc.indexOf('### Step 2: Branch Setup'), ciSrc.indexOf('### Step 3'))
  ;(/Under a workflow, the workflow decides isolation/.test(wt) && /When not under a workflow\*\* and the checkout may be\s+shared[\s\S]*git worktree add/.test(wt) ? ok : bad)(
    'code-issue creates its own worktree only when not under a workflow; under a workflow the workflow decides isolation')
}

// No agent sets `model:` (#56). Since Claude Code v2.1.251 an explicit frontmatter model,
// `inherit` included, outranks CLAUDE_CODE_SUBAGENT_MODEL; omitting it lets the variable
// apply. Model routing is the workflow's job, per call. An agent that genuinely needs a pin
// goes on this allowlist, with the reason, in the same PR.
const MODEL_PIN_ALLOWED = new Set([])
{
  const pinned = agentFiles.filter((f) => !MODEL_PIN_ALLOWED.has(basename(f, '.md'))
    && /^model:/m.test(readFileSync(join(ROOT, 'agents', f), 'utf8').split('\n---')[0]))
  ;(pinned.length === 0 ? ok : bad)(`no agent sets model: in its frontmatter, not even inherit${pinned.length ? ` (found in ${pinned.join(', ')})` : ''}`)
}

// every Agent(...) reference must be namespaced and resolve to a real agent
for (const file of agentFiles) {
  const src = readFileSync(join(ROOT, 'agents', file), 'utf8')
  const fm = frontmatter(src, file)
  const m = /Agent\(([^)]*)\)/.exec(fm?.tools || '')
  if (!m) continue
  for (const ref of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!ref.startsWith('delivery:')) bad(`${file}: Agent ref "${ref}" not namespaced`)
    else if (!agentNames.has(ref.slice('delivery:'.length))) bad(`${file}: Agent ref "${ref}" has no such agent`)
    else ok(`${file}: Agent(${ref}) resolves`)
  }
}

// every preloaded `skills:` entry must be namespaced and name a real skill
// directory (matched against the directory names, so `../` tricks fail). Claude
// Code skips a missing one with only a debug-log warning, so a typo leaves the
// agent with no procedure at all. A bare name is rejected because it can match
// a same-named skill from elsewhere (the built-in `code-review`, for one).
// The two procedure agents must also declare theirs: their fallback text says
// the body is preloaded, so a silent removal would leave them with none.
const skillDirs = new Set(SKILLS)
const MUST_PRELOAD = { 'code-issue': 'delivery:code-issue', 'code-review': 'delivery:code-review' }
for (const file of agentFiles) {
  const stem = basename(file, '.md')
  const fm = frontmatter(readFileSync(join(ROOT, 'agents', file), 'utf8'), file)
  const refs = (fm?.skills || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (MUST_PRELOAD[stem] && !refs.includes(MUST_PRELOAD[stem])) {
    bad(`${file}: must declare skills: ${MUST_PRELOAD[stem]}`)
  }
  for (const ref of refs) {
    if (!ref.startsWith('delivery:')) bad(`${file}: skills entry "${ref}" not namespaced`)
    else if (!skillDirs.has(ref.slice('delivery:'.length))) bad(`${file}: skills entry "${ref}" has no such skill`)
    else ok(`${file}: skills ${ref} resolves`)
  }
}

// -------------------------------------------------------------------- skills
console.log('\n== skills/ ==')
for (const e of readdirSync(join(ROOT, 'skills'), { withFileTypes: true })) {
  if (e.isDirectory() && !SKILLS.includes(e.name)) bad(`skills/${e.name}: no SKILL.md`)
}
for (const dir of SKILLS) {
  const p = join(ROOT, 'skills', dir, 'SKILL.md')
  const fm = frontmatter(readFileSync(p, 'utf8'), `skills/${dir}/SKILL.md`)
  if (!fm) continue
  if (fm.name !== dir) bad(`skills/${dir}: name "${fm.name}" != directory`)
  else if (!fm.description) bad(`skills/${dir}: no description`)
  else ok(`skills/${dir}: frontmatter ok (${fm.description.length} char description)`)
}

// Anthropic's skill guidance keeps a SKILL.md to 500 lines; detail goes in reference files (#54).
{
  const long = SKILLS.map((d) => [d, readFileSync(join(ROOT, 'skills', d, 'SKILL.md'), 'utf8').split('\n').length - 1]).filter(([, n]) => n > 500)
  ;(long.length === 0 ? ok : bad)(`every skills/*/SKILL.md is at most 500 lines${long.length ? ` (over: ${long.map(([d, n]) => `${d} ${n}`).join(', ')})` : ''}`)
}

// Every file a skill or agent points at through ${CLAUDE_PLUGIN_ROOT} must exist: a reference
// file moved out of a preloaded skill is read on demand, and a dangling pointer silently drops
// the rules it held.
{
  const refs = []
  for (const f of [...agentFiles.map((a) => `agents/${a}`), ...SKILLS.flatMap((d) =>
    readdirSync(join(ROOT, 'skills', d)).filter((x) => x.endsWith('.md')).map((x) => `skills/${d}/${x}`))]) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+[\w])/g)) refs.push([f, m[1]])
  }
  const dangling = refs.filter(([, r]) => !existsSync(join(ROOT, r)))
  ;(refs.length && dangling.length === 0 ? ok : bad)(
    `every \${CLAUDE_PLUGIN_ROOT} path named in a skill or agent exists (${refs.length} references${dangling.length ? `; dangling: ${dangling.map(([f, r]) => `${f} -> ${r}`).join(', ')}` : ''})`)
}

// The orient steps of the two procedure skills are one batched Bash call, then one
// response of parallel reads: every separate fetch is a full model turn over a
// growing context. The batch is joined with `;`, never `&&`, so a missing
// .claude/delivery.md or a PR with no checks does not abort the rest of it.
const sectionOf = (src, heading) => {
  const i = src.indexOf(heading)
  if (i === -1) return ''
  const rest = src.slice(i + heading.length)
  const end = rest.search(/\n#{2,3} /)
  return end === -1 ? rest : rest.slice(0, end)
}
const bashBlocks = (text) => [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
const checkSkill = (cond, msg) => (cond ? ok(msg) : bad(msg))
{
  const review = readFileSync(join(ROOT, 'skills/code-review/SKILL.md'), 'utf8')
  const orient = sectionOf(review, '### Step 1: Orient')
  const blocks = bashBlocks(orient)
  const batch = blocks[0] || ''
  checkSkill(blocks.length === 1, `code-review Orient has exactly one batched Bash call (found ${blocks.length})`)
  checkSkill(['gh pr view', 'files', 'gh pr diff', 'gh pr checks', 'cat .claude/delivery.md 2>/dev/null'].every((t) => batch.includes(t)),
    'code-review Orient batch fetches PR, files, diff, checks and .claude/delivery.md')
  checkSkill(!batch.includes('&&'), 'code-review Orient batch is joined with ; so one failure does not abort it')
  checkSkill(!/--json files/.test(review), 'code-review has no separate --json files fetch')
  // #53 deliberately narrows the LIGHT review's reads (checked on LIGHT_SCOPE below); a full
  // review still reads every changed file in full.
  checkSkill(/single response/i.test(orient) && /on a full review, \*\*every changed file, in full\*\*/i.test(orient),
    'code-review Orient: a full review reads every changed file in full, in parallel in a single response')
  {
    const FULL = 'skills/code-review/FULL_REVIEW_STEPS.md'
    const full = existsSync(join(ROOT, FULL)) ? readFileSync(join(ROOT, FULL), 'utf8') : ''
    checkSkill(['### Step 3: Design Review', '### Step 6: Performance Review', '### Step 8: Documentation Review'].every((h) => full.includes(h))
      && /On a full review, read `\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/code-review\/FULL_REVIEW_STEPS\.md` now/.test(sectionOf(review, '### Step 3: Design Review')),
      `code-review Step 3 tells a full review to read ${FULL}, which exists and holds Steps 3, 6 and 8`)
    const words = review.split(/\s+/).filter(Boolean).length
    checkSkill(words <= 2900, `skills/code-review/SKILL.md is at most 2,900 words, 70% of 0.7.1's 4,143 (has ${words})`)
    checkSkill(sectionOf(review, '## Shell Execution Rules').includes('${CLAUDE_PLUGIN_ROOT}/skills/code-issue/SHELL_RULES.md'),
      'code-review keeps a Shell Execution Rules digest that points at the shared skills/code-issue/SHELL_RULES.md')
  }
  checkSkill(!/If\s+`\.claude\/delivery\.md` exists, read it/.test(sectionOf(review, '## Step 0')),
    'code-review Step 0 folds the .claude/delivery.md read into the Orient batch')
  checkSkill(/echo '=== AGENTS'; \\\n\s*\[ -f CLAUDE\.md \] \|\| cat AGENTS\.md/.test(batch),
    'code-review Orient labels the AGENTS.md fallback so it is not read as delivery rules')

  const issue = readFileSync(join(ROOT, 'skills/code-issue/SKILL.md'), 'utf8')
  const plan = sectionOf(issue, '### Step 1: Planning')
  const iblocks = bashBlocks(plan)
  checkSkill(iblocks.length === 1 && ['gh issue view', 'cat .claude/delivery.md 2>/dev/null'].every((t) => iblocks[0].includes(t)) && !iblocks[0].includes('&&'),
    'code-issue Step 1 has one ;-joined batch fetching the issue and .claude/delivery.md')
  checkSkill(/single response/i.test(plan), 'code-issue Step 1 reads files in parallel in a single response')
  checkSkill(!/If\s+`\.claude\/delivery\.md` exists, read it/.test(sectionOf(issue, '## Step 0')),
    'code-issue Step 0 folds the .claude/delivery.md read into the Step 1 batch')
  checkSkill(/echo '=== AGENTS'; \\\n\s*\[ -f CLAUDE\.md \] \|\| cat AGENTS\.md/.test(iblocks[0] || ''),
    'code-issue Step 1 labels the AGENTS.md fallback so it is not read as delivery rules')
  // The CI wait must say what to do with each outcome, not only a timeout.
  const ci = sectionOf(issue, '### Step 5: CI Validation')
  checkSkill(/`fail`/.test(ci) && /gh run view [^`\n]*--log-failed/.test(ci) && /push, and wait again/.test(ci),
    'code-issue Step 5 says a fail bucket means read the failed log, fix, push, and wait again')
  checkSkill(ci.includes('no checks reported') && /not configured/.test(ci),
    'code-issue Step 5 says "no checks reported" is CI not configured, not passed')
  // `--no-watch` is not a universal run-once flag; some runners reject it. The full shell
  // rules live in a shared reference file (#52); the inline section is a digest that names it.
  // Both must state the same CI-wait ceiling as Step 5.
  const SHELL_FILE = 'skills/code-issue/SHELL_RULES.md'
  const shellDigest = sectionOf(issue, '## Shell Execution Rules')
  const shellFull = existsSync(join(ROOT, SHELL_FILE)) ? readFileSync(join(ROOT, SHELL_FILE), 'utf8') : ''
  checkSkill(shellFull && shellDigest.includes(`\${CLAUDE_PLUGIN_ROOT}/${SHELL_FILE}`) && shellDigest.trim().split('\n').length <= 14,
    `code-issue keeps a Shell Execution Rules digest (at most ~10 rule lines) that points at ${SHELL_FILE}, which exists`)
  const shell = shellDigest + '\n' + shellFull
  // The Bash tool's foreground maximum is 600000 ms; Step 5 and Shell rule 2 must state it and agree.
  const BASH_MAX_MS = 600000
  const rule2 = (t) => { const i = t.indexOf('2. **No watch mode**'); if (i === -1) return ''; const e = t.slice(i).search(/\n\s*3\. \*\*/); return e === -1 ? t.slice(i) : t.slice(i, i + e) }
  const ceilings = (t) => [...t.matchAll(/`timeout` of at most `(\d+)` ms/g)].map((m) => Number(m[1]))
  const stepMs = ceilings(ci), ruleMs = [...ceilings(rule2(shellDigest)), ...ceilings(rule2(shellFull))]
  checkSkill(stepMs.length === 1 && ruleMs.length === 2 && stepMs[0] <= BASH_MAX_MS && ruleMs.every((n) => n === stepMs[0]),
    `code-issue Step 5, the shell digest's rule 2 and ${SHELL_FILE} rule 2 state the same CI-wait ceiling, at most ${BASH_MAX_MS} ms (found ${stepMs} / ${ruleMs})`)
  checkSkill(!shell.includes('--no-watch') && shell.includes('--watch=false'),
    'code-issue shell rule 2 gives --watch=false, not --no-watch, as a run-once form')

  // The preloaded code-issue core (#52): at least 30% shorter than at 0.7.1 (4,289 words), and
  // the must-hold rules -- one issue, test-first, coverage, security -- come before the first
  // pointer to a reference file, so a compacted copy still carries them.
  {
    const words = issue.split(/\s+/).filter(Boolean).length
    checkSkill(words <= 3002, `skills/code-issue/SKILL.md is at most 3,002 words, 70% of 0.7.1's 4,289 (has ${words})`)
    const firstRef = issue.indexOf('${CLAUDE_PLUGIN_ROOT}/skills/code-issue/')
    const musts = { 'one issue': 'one GitHub issue per branch and PR', 'test-first': '#### 3a. Test-Driven Development',
      coverage: 'at least 80% on the code you', security: '**Security blocking rule**' }
    const late = Object.entries(musts).filter(([, t]) => { const i = issue.indexOf(t); return i === -1 || firstRef === -1 || i > firstRef }).map(([k]) => k)
    checkSkill(late.length === 0, `code-issue states the one-issue, test-first, coverage and security rules before its first reference-file pointer${late.length ? ` (late or missing: ${late.join(', ')})` : ''}`)
  }

  // Only the plan-epic workflow reaches these two, and it is not a user.
  const planner = readFileSync(join(ROOT, 'skills/epic-planner/SKILL.md'), 'utf8')
  const gather = readFileSync(join(ROOT, 'skills/research-gather/SKILL.md'), 'utf8')
  const DISPATCH_SKIP = /If a workflow or another agent dispatched you, skip/
  checkSkill(DISPATCH_SKIP.test(sectionOf(planner, '### Step 7: Handoff')),
    'epic-planner Step 7 skips the user handoff when dispatched')
  // The compile step embeds a markdown template with its own ### headings, so bound it by the
  // handoff step. Both headings must exist: indexOf -1 would make the slice cover most of the
  // file. #54 removed the enterprise step, so Compile is Step 6 and Handoff is Step 7.
  const g7 = gather.indexOf('### Step 6: Compile'), g8 = gather.indexOf('### Step 7: Handoff')
  checkSkill(g7 > 0 && g8 > g7, 'research-gather has its Step 6 (Compile) and Step 7 (Handoff) headings, in order, to bound Step 6')
  checkSkill(g7 > 0 && g8 > g7 && DISPATCH_SKIP.test(gather.slice(g7, g8)),
    'research-gather Step 6 (Compile) skips the user question when dispatched')
  // No agent allowlists an enterprise-search server, so that step could never run (#54); and
  // the research menus offer sources, not planning, which /delivery:plan-epic already runs.
  checkSkill(!/Microsoft|Copilot|Enterprise/i.test(gather), 'research-gather names no Microsoft 365 / Copilot / enterprise-search step')
  const menu = (gather.match(/\n> \d+\. \*\*[^*]+\*\*/g) || []).map((l) => l.replace(/\n> \d+\. /, ''))
  checkSkill(menu.length >= 4 && menu.every((m) => !/plan|epic|enterprise/i.test(m)),
    `research-gather's source menu offers only sources, nothing plan-epic already runs (${menu.join(', ')})`)
  checkSkill(!/\n> \d+\. \*\*(Read local documents|Research from the web|Look up library docs)/.test(sectionOf(planner, '#### 0c. Research Sources')),
    'epic-planner 0c runs no research menu of its own; research-gather and plan-epic own research')

  // One security blocking rule, stated once in code-issue Step 4 and quoted word for word
  // by code-review and the orchestrator agent, so the implementer never ships a finding the
  // reviewer then blocks on. One audit level everywhere, and one severity scale: the
  // REVIEW_SCHEMA enum.
  {
    const orch = readFileSync(join(ROOT, 'agents/orchestrator.md'), 'utf8')
    const norm = (t) => t.replace(/\s+/g, ' ')
    const ruleOf = (t) => { const m = /\*\*Security blocking rule\*\*[\s\S]*?structured output\./.exec(t); return m ? norm(m[0]) : null }
    const canon = ruleOf(sectionOf(issue, '### Step 4: Security Scan'))
    checkSkill(canon && /`critical` or `high` security finding blocks/.test(canon),
      'code-issue Step 4 states the security blocking rule (critical and high block)')
    for (const [name, t] of [['code-review', review], ['agents/orchestrator.md', orch]]) {
      checkSkill(canon && ruleOf(t) === canon, `${name} quotes the security blocking rule word for word`)
    }
    const walkText = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walkText(join(d, e.name)) : /\.(md|js)$/.test(e.name) ? [join(d, e.name)] : [])
    const files = ['skills', 'agents', 'workflows'].flatMap(walkText)
    const levels = new Set(files.flatMap((f) => [...readFileSync(join(ROOT, f), 'utf8').matchAll(/audit-level=(\w+)/g)].map((m) => m[1])))
    const lvl = (t) => new Set([...t.matchAll(/audit-level=(\w+)/g)].map((m) => m[1]))
    checkSkill(levels.size === 1 && JSON.stringify([...lvl(issue)]) === JSON.stringify([...lvl(orch)]),
      `one --audit-level in skills, agents and workflows, the same in code-issue and the orchestrator (found ${JSON.stringify([...levels])})`)
    const blocking = review.slice(review.indexOf('**What makes a finding blocking**'), review.indexOf('**Review body structure:**'))
    const sevBlocks = (t) => ['critical', 'high', 'medium'].filter((s) => new RegExp(`\\b${s}\\b[^.]*security finding`, 'i').test(t))
    checkSkill(sevBlocks(blocking).length === 0 && /security blocking rule/.test(blocking),
      `code-review's blocking list defers to the security blocking rule rather than naming its own severities${sevBlocks(blocking).length ? ` (names ${sevBlocks(blocking)})` : ''}`)
    const orchSrc = readFileSync(join(ROOT, 'workflows/orchestrate.js'), 'utf8')
    const enumM = /severity: \{ type: 'string', enum: \[([^\]]*)\]/.exec(orchSrc)
    const scale = enumM ? enumM[1].replace(/['\s]/g, '').split(',').join(' | ') : null
    checkSkill(scale && canon?.includes(`\`${scale}\``), `the rule's severity scale is REVIEW_SCHEMA's enum (${scale})`)
    const informational = files.filter((f) => /\bInformational\b/.test(readFileSync(join(ROOT, f), 'utf8')))
    checkSkill(informational.length === 0, `"Informational" is not used as a severity in skills, agents or workflows${informational.length ? ` (found in ${informational})` : ''}`)
  }

  // Unattended runs: the rule in every dispatchable agent, no unconditional CLAUDE.md
  // re-read, and every "ask the user" step conditioned on an interactive run.
  {
    for (const a of ['code-planner', 'research', 'code-review', 'code-issue']) {
      checkSkill(squash(readFileSync(join(ROOT, 'agents', `${a}.md`), 'utf8')).includes(UNATTENDED),
        `agents/${a}.md carries the unattended-run rule word for word`)
    }
    const texts = [...agentFiles.map((f) => `agents/${f}`), ...SKILLS.map((d) => `skills/${d}/SKILL.md`)]
    const rereads = texts.filter((f) => /Read (the project's )?\*{0,2}`CLAUDE\.md`/.test(readFileSync(join(ROOT, f), 'utf8')))
    checkSkill(rereads.length === 0, `no agent or skill tells the agent to read CLAUDE.md unconditionally${rereads.length ? ` (found in ${rereads.join(', ')})` : ''}`)
    // #55: the CLAUDE.md / AGENTS.md / neither rule is kept once, in each skill's opening
    // section, which every invocation reads; the agents and workflow prompts point at it.
    for (const [f, h] of [['skills/code-issue/SKILL.md', '## Step 0'], ['skills/code-review/SKILL.md', '## Step 0'],
      ['skills/research-gather/SKILL.md', '## Before You Start'], ['skills/epic-planner/SKILL.md', '## Before You Start']]) {
      checkSkill(/has neither/.test(sectionOf(readFileSync(join(ROOT, f), 'utf8'), h)), `${f} ${h} says what to do when the repository has neither CLAUDE.md nor AGENTS.md`)
    }
    const restated = ['code-planner', 'research', 'code-review', 'code-issue']
      .filter((a) => /CLAUDE\.md` is (normally )?already in your context|CLAUDE\.md` is already in your context/.test(readFileSync(join(ROOT, 'agents', `${a}.md`), 'utf8')))
    checkSkill(restated.length === 0, `no dispatchable agent restates the CLAUDE.md-in-context rule its skill states${restated.length ? ` (${restated.join(', ')})` : ''}`)
    // #55: gh / no-MCP is a tools fact, kept in the agent files; the procedure skills do not repeat it.
    checkSkill(['code-issue', 'code-review'].every((a) => /Assume you have no MCP tools/.test(readFileSync(join(ROOT, 'agents', `${a}.md`), 'utf8'))
      && !/MCP servers are optional and may be absent/.test(readFileSync(join(ROOT, 'skills', a, 'SKILL.md'), 'utf8'))),
      'the no-MCP / use-gh rule is stated in the code-issue and code-review agents, not again in their skills')
    // #55: the canvas and filter rules live in the e2e-test and ui-vision skills only.
    const A11Y = /(invisible to|does not appear in) the accessibility tree/g
    const BEFORE_AFTER = /before and after/gi
    const n = (t, re) => (t.match(re) || []).length
    checkSkill(['e2e-test', 'ui-vision'].every((a) => {
      const sk = readFileSync(join(ROOT, 'skills', a, 'SKILL.md'), 'utf8'), ag = readFileSync(join(ROOT, 'agents', `${a}.md`), 'utf8')
      return n(sk, A11Y) === 1 && n(ag, A11Y) === 0 && n(sk, BEFORE_AFTER) === 1 && n(ag, BEFORE_AFTER) <= 1 && !/Screenshot \*\*before and after\*\*/.test(ag)
    }),
      'the canvas and filter rules exist once each, in the e2e-test and ui-vision skills, not in their agents')
    // #55: the planner's report shape is the plan-epic prompt (dispatched) and epic-planner Step 7 (interactive).
    checkSkill(!/## Output format/.test(readFileSync(join(ROOT, 'agents/code-planner.md'), 'utf8')),
      'agents/code-planner.md does not define the planner output format a third time')
    // #55: the durable-finding format is REVIEW_SCHEMA.durableFinding, not agent prose.
    const orchSrc55 = readFileSync(join(ROOT, 'workflows/orchestrate.js'), 'utf8')
    checkSkill(!/Durable finding:/.test(readFileSync(join(ROOT, 'agents/code-review.md'), 'utf8'))
      && /durableFinding: \{[\s\S]*?could not derive by reading the code[\s\S]*?one-off finding/.test(orchSrc55),
      'the durable-finding format is described by REVIEW_SCHEMA.durableFinding, not in agents/code-review.md prose')
    const ASK = /\bask(s)? (the user|clarifying|before|first)\b|\bAsk the user\b|Would you like me to/
    const unconditioned = []
    for (const f of ['agents/code-planner.md', 'agents/research.md', 'agents/code-review.md', 'agents/code-issue.md',
      'skills/research-gather/SKILL.md', 'skills/epic-planner/SKILL.md', 'skills/code-issue/SKILL.md', 'skills/code-review/SKILL.md']) {
      for (const sec of readFileSync(join(ROOT, f), 'utf8').split(/\n(?=#{2,4} )/)) {
        if (ASK.test(sec) && !/interactive|dispatched/i.test(sec)) unconditioned.push(`${f}: ${sec.split('\n')[0]}`)
      }
    }
    checkSkill(unconditioned.length === 0,
      `every "ask the user" step in the dispatchable agents and their skills is conditioned on an interactive run${unconditioned.length ? ` (unconditioned: ${unconditioned.join('; ')})` : ''}`)
  }

  for (const [name, src] of [['code-review', review], ['code-issue', issue]]) {
    checkSkill(!/0\. RULES[^\n]*delivery\.md/.test(src), `${name} overview box no longer lists a separate .claude/delivery.md read`)
    checkSkill(!/using `&&`\. Never open/.test(src) && /not `&&`|never `&&`|`;`/.test(sectionOf(src, '## Shell Execution Rules')),
      `${name} shell rule 1 allows the deliberate ; batch`)
  }
}

// The cost-report skill is read-only: its only command is the report script, it
// names no GitHub write and no agent dispatch, and it shows metrics, never the
// result's prose. A future edit that adds a write fails here.
{
  const body = readFileSync(join(ROOT, 'skills/cost-report/SKILL.md'), 'utf8')
  const SCRIPT_CALL = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/cost-report.mjs"'
  // The whole line must be the call plus single-quoted paths and the script's own
  // flags. A prefix match would pass `<call> '<path>'; rm -rf ~/x`.
  const ONLY_CALL = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cost-report\.mjs"(?: +(?:'[^']*'|--include-concurrent|--verbose|--json|--discover|--last|--since))*$/
  const cmds = bashBlocks(body).flatMap((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
  checkSkill(cmds.length > 0 && cmds.every((l) => ONLY_CALL.test(l)),
    `cost-report: every command in the body is exactly ${SCRIPT_CALL} plus quoted paths and flags (found ${JSON.stringify(cmds)})`)
  const base = `${SCRIPT_CALL} '<path>'`
  const chained = ['; rm -rf ~/x', ' && cat x', ' || cat x', ' | tee x', ' $(cat x)', ' `cat x`', ' > out.txt', ' < in.txt', ' & cat x']
    .filter((tail) => ONLY_CALL.test(base + tail))
  checkSkill(ONLY_CALL.test(base) && ONLY_CALL.test(`${base} '<path>' --include-concurrent`) && chained.length === 0,
    `cost-report: the command check rejects anything chained, piped, substituted or redirected after the call${chained.length ? ` (accepted ${JSON.stringify(chained)})` : ''}`)
  checkSkill(!/(^|[^{])\$CLAUDE_PLUGIN_ROOT/.test(body),
    'cost-report: uses the substituted ${CLAUDE_PLUGIN_ROOT}, not $CLAUDE_PLUGIN_ROOT (unset in the Bash tool)')
  const writes = [/\bgh\s+issue\s+(edit|create|close|comment|delete|reopen|transfer|lock)\b/,
    /\bgh\s+pr\s+(create|edit|close|merge|comment|review|ready|reopen|lock)\b/, /\bgh\s+api\b/,
    /\bagent\s*\(/i, /\bAgent tool\b/, /subagent_type/]
  const hits = writes.filter((re) => re.test(body)).map(String)
  checkSkill(hits.length === 0, `cost-report: names no gh write and no agent dispatch${hits.length ? ` (found ${hits.join(', ')})` : ''}`)
  checkSkill(/show only the metrics fields/i.test(body)
    && /`research`, `plan`, `review` and\s+`implemented` text[^.]*;\s*never show/.test(body),
    'cost-report: shows only metrics fields, never the research/plan/review/implemented text')
  const noArgs = sectionOf(body, '## With no arguments')
  checkSkill(/print the usage[^.]*and stop/i.test(noArgs) && /Read nothing outside the paths you were given/.test(noArgs)
    && /save|copy the result/i.test(noArgs) && /The one search is `--discover`, and it\s+runs only when the maintainer passed `--discover`/.test(noArgs),
    'cost-report: with no arguments it prints how to save a result, stops, and reads nothing else; --discover is the one search, only when passed')
  const disc = sectionOf(body, '## With --discover')
  const discCmds = bashBlocks(disc).flatMap((b) => b.split('\n').map((l) => l.trim()).filter(Boolean))
  checkSkill(/^Only when the maintainer passed `--discover`/.test(disc.split('\n').slice(1).join('\n').trim())
    && /undocumented and may change between Claude Code versions/.test(disc) && /no runs found under/.test(disc)
    && discCmds.length > 0 && discCmds.every((l) => l.includes(' --discover')),
    'cost-report: the --discover section runs only when passed, says the layout is undocumented and may change, and explains "no runs found"')
  checkSkill(/task output/i.test(noArgs) && /`\*\.output`/.test(noArgs) && /completion notice/i.test(noArgs),
    'cost-report: the usage text says a finished run\'s task output can be passed directly, and where it is written')
}

// The skill count stated in each manifest and the README must be the real one.
{
  const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
  const want = SKILLS.length
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'README.md', 'docs/installation.md']) {
    const t = readFileSync(join(ROOT, f), 'utf8')
    const found = [...t.matchAll(new RegExp(`\\b(${NUM.join('|')}) skills\\b`, 'gi'))].map((m) => NUM.indexOf(m[1].toLowerCase()))
      .concat([...t.matchAll(/\bSkills \((\d+)\)/g)].map((m) => Number(m[1])))
      .concat([...t.matchAll(/count lower than (\d+) or/g)].map((m) => Number(m[1])))
    checkSkill(found.length > 0 && found.every((n) => n === want),
      `${f}: every stated skill count is ${want}, the number of skills/ directories (found ${JSON.stringify(found)})`)
  }
  // The agent count stated alongside it must be the real one too (#64).
  for (const f of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'README.md', 'docs/installation.md']) {
    const t = readFileSync(join(ROOT, f), 'utf8')
    // Only a count stated beside the skill count ("seven agents and nine skills"), not prose
    // such as "a clean issue costs two agents".
    const found = [...t.matchAll(new RegExp(`\\b(${NUM.join('|')}) agents(?:,|\\s+and)\\s+(?:${NUM.join('|')})\\s+skills\\b`, 'gi'))].map((m) => NUM.indexOf(m[1].toLowerCase()))
      .concat([...t.matchAll(/\bAgents \((\d+)\)/g)].map((m) => Number(m[1])))
    checkSkill(found.length > 0 && found.every((n) => n === agentFiles.length),
      `${f}: every stated agent count is ${agentFiles.length}, the number of agents/*.md files (found ${JSON.stringify(found)})`)
  }
  {
    const d = join(tmpdir(), `skills-stray-${process.pid}`)
    rmSync(d, { recursive: true, force: true })
    for (const s of ['alpha', 'beta']) { mkdirSync(join(d, 'skills', s), { recursive: true }); copyFileSync(join(ROOT, 'skills', SKILLS[0], 'SKILL.md'), join(d, 'skills', s, 'SKILL.md')) }
    mkdirSync(join(d, 'skills', 'empty'))
    copyFileSync(join(ROOT, 'README.md'), join(d, 'skills', '.DS_Store'))
    const got = skillDirsIn(d)
    checkSkill(JSON.stringify(got) === '["alpha","beta"]',
      `a stray file or a directory with no SKILL.md in skills/ is not counted as a skill (got ${JSON.stringify(got)})`)
    rmSync(d, { recursive: true, force: true })
  }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const missing = SKILLS.filter((d) => !sectionOf(readme, '### Skills').includes(`\`${d}\``))
  checkSkill(missing.length === 0, `README.md: the Skills section names every skill${missing.length ? ` (missing ${missing.join(', ')})` : ''}`)
  {
    const cr = await import(join(ROOT, 'scripts/cost-report.mjs'))
    const names = [...readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.js')).map((f) => `/delivery:${f.slice(0, -3)}`),
      '/delivery:cost-report', ...cr.FLAGS, ...cr.VALUED]
    const absent = names.filter((n) => !new RegExp(`${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(readme))
    checkSkill(cr.FLAGS.size > 0 && cr.VALUED.size > 0 && absent.length === 0,
      `README.md: names every /delivery:* command and every cost-report flag the script accepts${absent.length ? ` (missing ${absent.join(', ')})` : ''}`)
  }
  const usage = readFileSync(join(ROOT, 'docs/usage.md'), 'utf8')
  const cost = sectionOf(usage, '### Reading the cost of a run')
  checkSkill(cost.includes('(#what-the-result-measures)') && usage.includes('<a name="what-the-result-measures"></a>')
    && /concurrent/i.test(cost) && /proxy/i.test(cost),
    'docs/usage.md: "Reading the cost of a run" links "What the result measures" and repeats the concurrent and proxy caveats')
  checkSkill(/task output/i.test(cost) && /`\*\.output`/.test(cost) && /completion notice/i.test(cost),
    'docs/usage.md: "Reading the cost of a run" says a finished run\'s task output can be passed directly, and where it is written')
}

// A workflow's meta.phases titles, read without executing it (meta is a pure literal).
function extractMetaPhases(src) {
  return [...src.slice(src.indexOf('phases:'), src.indexOf('],', src.indexOf('phases:'))).matchAll(/title: '([^']+)'/g)].map((m) => m[1])
}

// ----------------------------------------------------------------- workflows
console.log('\n== workflows/ ==')

function extractMeta(src) {
  const i = src.indexOf('export const meta')
  const open = src.indexOf('{', i)
  let depth = 0, j = open, inStr = null, esc = false
  for (; j < src.length; j++) {
    const c = src[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') { depth--; if (depth === 0) break }
  }
  return src.slice(open, j + 1)
}

// A "pure literal" is an object of literals: no identifiers except keys, no
// calls, no operators, no template interpolation. Strip string contents first,
// then anything left must be punctuation and `key:` tokens.
function purityViolations(metaSrc) {
  const stripped = metaSrc.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
  const bad = []
  if (metaSrc.includes('${')) bad.push('template interpolation ${')
  if (/`/.test(metaSrc)) bad.push('template literal backtick')
  if (/[()]/.test(stripped)) bad.push('call or parenthesised expression')
  for (const op of ['+', '?', '=>', '...']) if (stripped.includes(op)) bad.push(`operator ${op}`)
  const idents = stripped.match(/[A-Za-z_$][A-Za-z0-9_$]*\s*:?/g) || []
  for (const t of idents) if (!t.trim().endsWith(':')) bad.push(`bare identifier "${t.trim()}"`)
  return bad
}

const CLEAN_REVIEW = {
  pr: 7, recommendation: 'Recommendation: merge — no blocking findings', blocking: false,
  findings: [{ severity: 'nit', location: 'a.ts:1', summary: 'naming', blocking: false }],
  verification: 'ran the suite',
}
const BLOCKING_REVIEW = {
  ...CLEAN_REVIEW, recommendation: 'Recommendation: do not merge — 1 blocking finding', blocking: true,
  findings: [{ severity: 'high', location: 'db.ts:9', summary: 'missing scope column', blocking: true }],
}

// What the fix agent reports. The declined reason is a sentinel so a test can
// prove the structured result reaches the re-reviewer rather than being dropped.
const FIX_RESULT = {
  changed: [{ finding: 'missing scope column', fix: 'filter on tenant_id', test: 'db.test.ts scoped read' }],
  declined: [{ finding: 'naming', reason: 'SENTINEL-DECLINED-REASON' }],
  gates: { passed: true, pushed: true, detail: 'suite green' },
}

// What the implementer reports for an issue, by case: the issue's own points
// and labels, and its PR's size. These drive the review routing.
const MEDIUM_ISSUE = { storyPoints: 5, labels: ['enhancement'], filesChanged: 3, linesChanged: 80 }
const SMALL_ISSUE = { storyPoints: 2, labels: ['bug'], filesChanged: 2, linesChanged: 40 }
const AT_LIMIT_ISSUE = { storyPoints: 1, labels: [], filesChanged: 5, linesChanged: 150 }

// Planted in every stub implementer report, so a test can prove the report never
// reaches a reviewer's prompt: the reviewer reads the PR, not the author's account.
const REPORT_SENTINEL = 'SENTINEL-IMPLEMENTER-REPORT'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const workflowFiles = readdirSync(join(ROOT, 'workflows')).filter((f) => f.endsWith('.js')).sort()
const stubParallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))

// Consecutive-distinct phases, whether set by phase() or by an agent's opts.phase.
// A stub `budget` whose spent() grows by a fixed, distinct amount per dispatch
// kind, so a per-phase delta can only be right if it is taken around the right call.
// Without `budget`, the runner leaves it undefined, as a runtime without it would.
const TOKENS = { implement: 1000, review: 200, fix: 30, rereview: 4, research: 500, plan: 60 }
const meteredBudget = () => {
  let n = 0
  return { budget: { total: null, spent: () => n, remaining: () => Infinity }, charge: (label) => { n += TOKENS[label.split(':')[0]] ?? 0 } }
}

function runner(body) {
  return async ({ argv = '412', review = CLEAN_REVIEW, facts = {}, implement, fix = FIX_RESULT, budget } = {}) => {
    const dispatches = [], logs = [], seq = []
    let current = null
    const meter = budget === 'metered' ? meteredBudget() : null
    const fn = new AsyncFunction('args', 'agent', 'phase', 'log', 'parallel', 'budget', body)
    const result = await fn(
      argv,
      async (prompt, o = {}) => {
        const p = o.phase || current
        if (seq[seq.length - 1] !== p) seq.push(p)
        dispatches.push({ ...o, prompt })
        meter?.charge(o.label || '')
        if (o.schema?.properties?.issues) {
          if (implement !== undefined) return typeof implement === 'function' ? implement(o) : implement
          const ids = o.label.slice('implement:'.length).split('+').map((x) => (x === 'task' ? 900 : Number(x)))
          return { issues: ids.map((n) => ({ issue: n, pr: n + 1000, headRefName: `feature/issue-${n}-stub`, ...MEDIUM_ISSUE, ...(facts[n] || {}), report: `${REPORT_SENTINEL} ${n}` })) }
        }
        // The fix schema must get a fix-shaped answer, not the review stub: a
        // review object here would let the phase checks pass for the wrong reason.
        if (o.schema?.properties?.changed) return fix
        if (o.schema) return typeof review === 'function' ? review(o) : review
        return `[stub ${o.label}]`
      },
      (t) => { current = t },
      (m) => logs.push(m),
      stubParallel,
      meter ? meter.budget : budget,
    )
    return { phases: seq, dispatches, logs, result }
  }
}

for (const file of workflowFiles) {
  const src = readFileSync(join(ROOT, 'workflows', file), 'utf8')

  // 1. parses as JS (as an ES module body)
  try { new AsyncFunction(src.replace(/^export /m, '')); ok(`${file}: parses as JavaScript`) }
  catch (e) { bad(`${file}: syntax error — ${e.message}`); continue }

  // 2. meta is a pure literal
  const metaSrc = extractMeta(src)
  const v = purityViolations(metaSrc)
  v.length ? bad(`${file}: meta not a pure literal — ${v.join('; ')}`) : ok(`${file}: meta is a pure literal`)

  // 3. meta evaluates with no globals available at all
  let meta
  try {
    meta = new Function(`"use strict"; return ${metaSrc}`).call(undefined)
    ok(`${file}: meta evaluates standalone (name=${meta.name}, ${meta.phases.length} phases)`)
  } catch (e) { bad(`${file}: meta will not evaluate — ${e.message}`); continue }
  if (meta.name !== basename(file, '.js')) bad(`${file}: meta.name "${meta.name}" != filename stem`)
  if (!meta.description || !meta.whenToUse) bad(`${file}: meta missing description/whenToUse`)

  // 4. run the body with stubbed agent/phase/log/parallel and check the phase order
  const body = src.replace(/export const meta = \{[\s\S]*?\n\}\n/, '')
  const run = runner(body)
  for (const [label, argv] of [['with an issue number', '412'], ['with a description', 'make the export honour a date range'], ['with no args', '']]) {
    try {
      const { phases, dispatches, logs, result } = await run({ argv })
      const expected = file === 'orchestrate.js' ? ['Implement', 'Review'] : ['Research', 'Plan']
      JSON.stringify(phases) === JSON.stringify(expected)
        ? ok(`${file} ${label}: phase order ${phases.join(' -> ')}`)
        : bad(`${file} ${label}: phase order ${phases.join(' -> ')} != ${expected.join(' -> ')}`)
      for (const d of dispatches) {
        if (!d.agentType?.startsWith('delivery:')) bad(`${file}: dispatch "${d.label}" has agentType ${d.agentType}`)
      }
      if (argv === '412' && file === 'orchestrate.js') {
        JSON.stringify(result.batches?.[0]?.issues) === '[412]'
          ? ok('orchestrate.js: bare number parsed as issue 412')
          : bad(`issue parsed as ${JSON.stringify(result.batches?.[0]?.issues)}`)
      }
      if (argv.startsWith('make the') && file === 'orchestrate.js') {
        result.batches[0].issues.length === 0 && !JSON.stringify(dispatches).includes('issue #make')
          ? ok('orchestrate.js: description not mangled into a fake issue reference')
          : bad('orchestrate.js: description became a fake issue reference')
      }
      if (argv === '' && logs.length === 0) bad(`${file}: no usage hint logged for empty args`)
      if (file === 'plan-epic.js' && label === 'with an issue number') {
        dispatches.length === 2 && dispatches.every((d) => d.prompt.includes('cat .claude/delivery.md 2>/dev/null')
          && !/If \.claude\/delivery\.md exists, read it/.test(d.prompt))
          ? ok('plan-epic.js: every dispatch reads .claude/delivery.md inside its first batched call, not separately')
          : bad('plan-epic.js: a dispatch still reads .claude/delivery.md as a separate step')
        dispatches.length === 2 && dispatches.every((d) => squash(d.prompt).includes(UNATTENDED) && /a repository with neither/.test(d.prompt))
          ? ok('plan-epic.js: every dispatch carries the unattended-run rule and the neither-CLAUDE.md-nor-AGENTS.md case')
          : bad('plan-epic.js: a dispatch lacks the unattended-run rule or the neither-file case')
        dispatches.every((d) => !('effort' in d))
          ? ok('plan-epic.js: no dispatch sets effort')
          : bad('plan-epic.js: a dispatch sets effort')
        result.outputTokens && result.outputTokens.research === null && result.outputTokens.plan === null
          ? ok('plan-epic.js: with no budget, output tokens are null and nothing throws')
          : bad(`plan-epic.js: output tokens without budget = ${JSON.stringify(result.outputTokens)}`)
      }
    } catch (e) { bad(`${file} ${label}: threw — ${e.message}`) }
  }

  if (file === 'plan-epic.js') {
    const { result } = await run({ budget: 'metered' })
    JSON.stringify(result.outputTokens) === JSON.stringify({ research: 500, plan: 60 })
      ? ok('plan-epic.js: output tokens per phase are budget.spent() deltas')
      : bad(`plan-epic.js: output tokens = ${JSON.stringify(result.outputTokens)}`)
    // The same broken shapes orchestrate.js is checked against (its copy of the helper).
    for (const [name, budget] of [['null', null], ['{} (no spent)', {}], ['whose spent is not a function', { spent: 42 }],
      ['whose spent() throws', { total: null, spent: () => { throw new Error('no') } }]]) {
      const msg = `plan-epic.js: with budget ${name}, output tokens are null and the run completes`
      try {
        const { result, phases } = await run({ budget })
        JSON.stringify(phases) === '["Research","Plan"]'
          && JSON.stringify(result.outputTokens) === JSON.stringify({ research: null, plan: null })
          ? ok(msg)
          : bad(`${msg} — got ${JSON.stringify(result.outputTokens)}`)
      } catch (e) { bad(`${msg} — threw: ${e.message}`) }
    }
  }

  if (file !== 'orchestrate.js') continue

  // 5. orchestrate.js: every routing and branching case.
  const modelOf = (ds, label) => (ds.find((d) => d.label === label) || {}).model ?? null
  const check = (cond, pass, fail) => (cond ? ok(`orchestrate.js: ${pass}`) : bad(`orchestrate.js: ${fail ?? pass}`))
  const pr0 = (r) => r.result.batches[0].prs[0]
  let r

  // --- no sizing agent
  r = await run()
  check(!r.dispatches.some((d) => d.label?.startsWith('size:') || d.agentType === 'delivery:research' || d.model === 'haiku'),
    'no separate sizing agent is dispatched')
  check(r.dispatches.length === 2, 'a clean single issue costs two agents (implement, review)', `clean run dispatched ${r.dispatches.length} agents`)
  const implSchema = r.dispatches.find((d) => d.label === 'implement:412')?.schema?.properties?.issues?.items?.properties || {}
  check(['storyPoints', 'labels', 'filesChanged', 'linesChanged', 'report'].every((k) => implSchema[k]),
    'the implementer reports points, labels and diff size as structured output')

  // --- the reviewer reads the PR body, not the implementer's own report
  r = await run({ review: BLOCKING_REVIEW })
  const reviewPrompts = r.dispatches.filter((d) => d.agentType === 'delivery:code-review')
  check(reviewPrompts.length === 2 && reviewPrompts.every((d) => !d.prompt.includes(REPORT_SENTINEL)),
    'no review or re-review prompt carries the implementer\'s report')
  check(r.dispatches.find((d) => d.label === 'review:412')?.prompt.includes('gh pr view 1412 --json body'),
    'the review prompt points the reviewer at the PR body')
  check(pr0(r).implemented?.includes(REPORT_SENTINEL) && r.result.batches[0].implemented?.[0]?.report?.includes(REPORT_SENTINEL),
    'the implementer\'s report is still in the returned result')

  // --- implementation routing on the caller's hint
  for (const [argv, want, name] of [
    ['412', null, 'no hint implements on the session model'],
    ['412 --points 2', 'sonnet', '--points 2 implements on sonnet'],
    ['412 --points=1', 'sonnet', '--points=1 implements on sonnet'],
    ['412 --small', 'sonnet', '--small implements on sonnet'],
    ['412 --points 5', null, '--points 5 implements on the session model'],
  ]) {
    r = await run({ argv })
    check(modelOf(r.dispatches, 'implement:412') === want, name, `${name} — got ${modelOf(r.dispatches, 'implement:412')}`)
  }

  // --- review routing on reported facts
  for (const [facts, want, name] of [
    [SMALL_ISSUE, 'sonnet', 'a 2-point, unlabelled-risk, small-diff PR gets a light sonnet review'],
    [AT_LIMIT_ISSUE, 'sonnet', 'a diff of exactly 5 files / 150 lines is still light'],
    [MEDIUM_ISSUE, null, 'a 5-point issue gets the full review on the session model'],
    [{ ...SMALL_ISSUE, labels: ['security'] }, null, 'a risk label forces the full review'],
    [{ ...SMALL_ISSUE, storyPoints: null }, null, 'no story points forces the full review'],
    [{ ...SMALL_ISSUE, labels: null }, null, 'unknown labels force the full review'],
    [{ ...SMALL_ISSUE, linesChanged: 151 }, null, '151 changed lines force the full review'],
    [{ ...SMALL_ISSUE, filesChanged: 6 }, null, '6 changed files force the full review'],
    [{ ...SMALL_ISSUE, filesChanged: null }, null, 'unknown diff size forces the full review'],
  ]) {
    r = await run({ facts: { 412: facts } })
    const rv = r.dispatches.find((d) => d.label === 'review:412')
    const light = rv?.prompt.includes('Review scope: LIGHT')
    check((rv?.model ?? null) === want && light === (want === 'sonnet'), name,
      `${name} — got model=${rv?.model ?? null} light=${light}`)
    check(r.logs.some((l) => l.startsWith('#412:') && l.includes('review on')), `the review routing is logged (${name})`)
  }
  {
    const lightP = (await run({ facts: { 412: SMALL_ISSUE } })).dispatches.find((d) => d.label === 'review:412')?.prompt || ''
    const fullP = (await run({ facts: { 412: MEDIUM_ISSUE } })).dispatches.find((d) => d.label === 'review:412')?.prompt || ''
    check(/read the diff plus only the changed files you need/.test(lightP) && /not every changed file in full/.test(lightP)
      && !/read the diff plus only the changed files/.test(fullP),
      'the light review is told to read the diff plus only the files it needs; the full review is not narrowed')
    check(/Skip Step 3 \(design\), Step 6 \(performance\) and Step 8/.test(lightP), 'the light review is still told to skip Steps 3, 6 and 8')
  }

  // --- --small-model picks the small tier's model (#57). No flag = sonnet, unchanged above.
  for (const [flag, want] of [['--small-model inherit', null], ['--small-model haiku', 'haiku'], ['--small-model=haiku', 'haiku'], ['--small-model sonnet', 'sonnet']]) {
    const smallImpl = await run({ argv: `412 --small ${flag}` })
    const light = await run({ argv: `412 ${flag}`, review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
    const full = await run({ argv: `412 ${flag}`, review: BLOCKING_REVIEW })
    const got = {
      implement: modelOf(smallImpl.dispatches, 'implement:412'),
      light: modelOf(light.dispatches, 'review:412'),
      fix: modelOf(full.dispatches, 'fix:412'),
      rereview: modelOf(full.dispatches, 'rereview:412'),
    }
    check(Object.values(got).every((m) => m === want)
      && light.dispatches.find((d) => d.label === 'review:412')?.prompt.includes('Review scope: LIGHT')
      && JSON.stringify(smallImpl.result.batches[0].issues) === '[412]',
      `${flag}: the small-issue implementer, the light review, the fix and the confirming re-review run on ${want ?? 'the session model'}`,
      `${flag}: got ${JSON.stringify(got)}`)
    check(modelOf(full.dispatches, 'review:412') === null && modelOf(light.dispatches, 'rereview:412') === null,
      `${flag}: the full review and an escalated re-review stay on the session model`)
  }
  r = await run({ argv: '412 --small --small-model haiku', review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
  check(modelOf(r.dispatches, 'fix:412') === null && r.logs.some((l) => l.includes('escalated: the haiku implementation')),
    'a haiku implementation that fails review escalates the fix to the session model')
  r = await run({ argv: 'make the export honour a date range --small-model haiku --small' })
  check(r.dispatches[0].prompt.includes('this request: make the export honour a date range end to end') && modelOf(r.dispatches, 'implement:task') === 'haiku',
    '--small-model is taken out of a description, not left in it')
  for (const bad of ['412 --small-model gpt-4', '412 --small-model', '412 --small-model=', '412 --small-model constructor']) {
    let threw = null, dispatched = 0
    try { const x = await run({ argv: bad }); dispatched = x.dispatches.length } catch (e) { threw = e.message }
    check(threw && /--small-model must be one of sonnet, inherit, haiku/.test(threw) && dispatched === 0,
      `an invalid --small-model ("${bad}") fails loudly at start and dispatches nothing`, `"${bad}": threw=${threw} dispatched=${dispatched}`)
  }

  // --- the fix branch is decided by structured output
  r = await run({ review: BLOCKING_REVIEW })
  check(JSON.stringify(r.phases) === JSON.stringify(['Implement', 'Review', 'Fix', 'Re-review'])
    && pr0(r).blockingFindings && pr0(r).fix && pr0(r).reReview && r.result.merged === false,
  `blocking review: ${r.phases.join(' -> ')}, merged=false`)
  check(r.dispatches.filter((d) => d.agentType === 'delivery:code-review').every((d) => d.schema?.properties?.blocking),
    'every review dispatch carries the structured-output schema')
  check(modelOf(r.dispatches, 'fix:412') === 'sonnet' && modelOf(r.dispatches, 'rereview:412') === 'sonnet',
    'after a full review, fix and re-review run on sonnet',
    `fix=${modelOf(r.dispatches, 'fix:412')} rereview=${modelOf(r.dispatches, 'rereview:412')}`)
  check(pr0(r).models?.review === 'session model' && pr0(r).models?.fix === 'sonnet',
    'the models used are reported in the result', `models = ${JSON.stringify(pr0(r).models)}`)

  // --- the procedure skills are preloaded via `skills:`, so no prompt may name one
  // as a slash skill: that cues a Skill call that loads the procedure a second time.
  check(!/\/delivery:code-/.test(src), 'the workflow source names no /delivery:code-* slash skill in any prompt')
  check(r.dispatches.length === 4 && r.dispatches.every((d) => !/\/delivery:code-/.test(d.prompt)),
    'no dispatched prompt names a /delivery:code-* slash skill')
  const PROCEDURE = { implement: 'code-issue', review: 'code-review', rereview: 'code-review' }
  const wrongProc = r.dispatches.filter((d) => {
    const want = PROCEDURE[d.label.split(':')[0]]
    return want && !d.prompt.includes(`following the ${want} procedure (preloaded)`)
  })
  check(r.dispatches.filter((d) => PROCEDURE[d.label.split(':')[0]]).length === 3 && wrongProc.length === 0,
    'implement, review and re-review prompts name their own preloaded procedure',
    wrongProc.map((d) => d.label).join(', '))
  const headerEnd = src.indexOf('const RULES')
  const header = src.slice(0, headerEnd)
  check(headerEnd > 0 && /preloaded/.test(header) && /skills:/.test(header) && !/skills each agent invokes/.test(header),
    'the header comment describes skills: preload, not invocation')
  const lr = await run({ review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
  check(lr.dispatches.length === 4 && lr.dispatches.every((d) => !/\/delivery:code-/.test(d.prompt)),
    'no light-route prompt (scope note, escalated re-review) names a /delivery:code-* slash skill')

  check(r.dispatches.every((d) => /Step 0 says how to\s+treat CLAUDE\.md, AGENTS\.md and a repository with neither/.test(d.prompt)),
    'every dispatch points at its procedure\'s Step 0 for CLAUDE.md, AGENTS.md and a repository with neither')

  // --- orientation is batched in every dispatch, with no separate delivery.md read
  check(r.dispatches.every((d) => d.prompt.includes('cat .claude/delivery.md 2>/dev/null')
    && !/If \.claude\/delivery\.md exists, read it/.test(d.prompt)),
  'every dispatch reads .claude/delivery.md inside its batched orient call, not separately')
  // Matched on the re-review's own wording: RULES says "one batched" in every prompt.
  check((r.dispatches.find((d) => d.label === 'rereview:412')?.prompt || '').includes('PR, diff, checks and .claude/delivery.md together'),
    'the re-review prompt points at the batched orient call')
  check((r.dispatches.find((d) => d.label === 'rereview:412')?.prompt || '').includes('files the findings name'),
    'a non-escalated re-review reads only the files the findings name')

  // --- the fix pushes to the existing PR branch in Fix mode, never a new branch or PR
  r = await run({ review: BLOCKING_REVIEW })
  const fixPrompt = r.dispatches.find((d) => d.label === 'fix:412')?.prompt || ''
  check(fixPrompt.includes('head branch is `feature/issue-412-stub`') && fixPrompt.includes('Push your fixes to that existing branch'),
    'the fix prompt names the PR head branch the implementer reported, and says to push to it')
  check(/Do not create a new branch or a new PR/.test(fixPrompt), 'the fix prompt says not to create a branch or a PR')
  check(fixPrompt.includes('Fix mode section of the code-issue procedure (preloaded)'),
    'the fix prompt points at the Fix mode section by name, not by a slash skill')
  r = await run({ review: BLOCKING_REVIEW, facts: { 412: { headRefName: null } } })
  const noHead = r.dispatches.find((d) => d.label === 'fix:412')?.prompt || ''
  check(noHead.includes('gh pr view 1412 --json headRefName') && !/head branch is `/.test(noHead),
    'with no reported head branch the fix is told to read it from gh, not given a guess')
  check(r.dispatches.find((d) => d.label === 'implement:412')?.prompt.includes('headRefName')
    && r.dispatches.find((d) => d.label === 'implement:412')?.schema?.properties?.issues?.items?.required?.includes('headRefName'),
    'the implementer is asked for each PR\'s headRefName as required structured output')
  {
    const issueSkill = readFileSync(join(ROOT, 'skills/code-issue/SKILL.md'), 'utf8')
    const fm = sectionOf(issueSkill, '## Fix mode')
    check(fm && fm.trim().split('\n').length <= 40 && /headRefName/.test(fm) && /no new branch and no new PR/i.test(fm)
      && /only the listed findings/i.test(fm) && /test and lint gates/i.test(fm)
      && ['security scan', 'living documents', 'PR creation'].every((t) => fm.includes(t)),
      'skills/code-issue has a Fix mode section of at most 40 lines naming the branch, what it skips and what it still runs')
  }

  // --- the fix returns structured output, and the re-reviewer sees it
  r = await run({ review: BLOCKING_REVIEW })
  const fixProps = r.dispatches.find((d) => d.label === 'fix:412')?.schema?.properties || {}
  check(['changed', 'declined', 'gates'].every((k) => fixProps[k]), 'the fix dispatch carries the changed/declined/gates schema')
  check(r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('SENTINEL-DECLINED-REASON'),
    'a declined finding\'s reason reaches the re-review prompt')
  const rrPrompt = (x) => x.dispatches.find((d) => d.label === 'rereview:412')?.prompt || ''
  check(rrPrompt(r).includes('- fixed: missing scope column — filter on tenant_id (test: db.test.ts scoped read)'),
    'a changed finding\'s fix and test reach the re-review prompt')
  check(rrPrompt(r).includes('Gates passed: true; pushed: true (suite green)'),
    'the gates line, with its detail, reaches the re-review prompt')
  check(JSON.stringify(pr0(r).fix) === JSON.stringify(FIX_RESULT), 'the structured fix result is returned')
  r = await run({ review: BLOCKING_REVIEW, fix: { ...FIX_RESULT, gates: { passed: false, pushed: false } } })
  check(r.dispatches.some((d) => d.label === 'rereview:412') && r.phases.includes('Re-review'),
    'a fix that did not push still gets its re-review')
  check(/Gates passed: false; pushed: false(\n|$)/.test(rrPrompt(r)),
    'a gates line with no detail reaches the re-review prompt with no empty detail')

  // A malformed fix result must not throw between the push and the re-review:
  // that is exactly the skipped-review failure this workflow exists to prevent.
  for (const [name, fix, want] of [
    ['changed missing', { declined: FIX_RESULT.declined, gates: FIX_RESULT.gates }, '- fixed: (not reported)'],
    ['declined missing', { changed: FIX_RESULT.changed, gates: FIX_RESULT.gates }, '- declined: (not reported)'],
    ['gates missing', { changed: FIX_RESULT.changed, declined: FIX_RESULT.declined }, 'Gates passed: (not reported); pushed: (not reported)'],
    ['gates null', { ...FIX_RESULT, gates: null }, 'Gates passed: (not reported); pushed: (not reported)'],
    ['gates empty', { ...FIX_RESULT, gates: {} }, 'Gates passed: (not reported); pushed: (not reported)'],
  ]) {
    const msg = `a fix result with ${name} still gets its re-review, which is told what was not reported`
    try {
      r = await run({ review: BLOCKING_REVIEW, fix })
      check(r.phases.includes('Re-review') && rrPrompt(r).includes(want), msg)
    } catch (e) { check(false, msg, `${msg} — threw: ${e.message}`) }
  }
  r = await run({ review: BLOCKING_REVIEW, fix: null })
  check(r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('did not return'),
    'a fix that never returned is named as such to the re-reviewer')

  r = await run({ review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
  check(modelOf(r.dispatches, 'rereview:412') === null
    && !r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('Review scope: LIGHT')
    && r.dispatches.find((d) => d.label === 'rereview:412')?.prompt.includes('full-scope'),
  'a light review that blocks escalates the re-review to a full one on the session model')
  check(/every changed file, in full/.test(r.dispatches.find((d) => d.label === 'rereview:412')?.prompt || '')
    && !/files the findings name/.test(r.dispatches.find((d) => d.label === 'rereview:412')?.prompt || ''),
  'an escalated re-review reads every changed file in full, not only the files the findings name')

  r = await run({ argv: '412 --small', review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
  check(modelOf(r.dispatches, 'fix:412') === null, 'a sonnet implementation that fails review escalates the fix')

  r = await run({ review: { ...CLEAN_REVIEW, findings: [{ ...BLOCKING_REVIEW.findings[0] }] } })
  check(r.phases.includes('Fix') && pr0(r).fix, 'a blocking finding under blocking=false still triggers the fix')

  r = await run({ review: null })
  check(pr0(r).reviewCompleted === false && r.result.reviewCompleted === false && !r.phases.includes('Fix'),
    'a review that never returned marks the run unreviewed')

  r = await run({ implement: null })
  check(r.result.reviewCompleted === false && !r.dispatches.some((d) => d.label?.startsWith('review:')),
    'an implementer that never returned marks the run unreviewed')

  // --- effort per stage: explicit high on the implementer, the first full review and an
  // escalated re-review; medium only on the fix and the confirming re-review. Nothing
  // inherits: the session default on Opus 5.5 is medium, so "inherit" would mean medium.
  const optsOf = (x, label) => x.dispatches.find((d) => d.label === label) || {}
  r = await run({ review: BLOCKING_REVIEW })
  check(optsOf(r, 'implement:412').effort === 'high', 'the implementer runs at high effort, passed explicitly',
    `implement effort = ${optsOf(r, 'implement:412').effort}`)
  check(optsOf(r, 'review:412').effort === 'high', 'the first full review runs at high effort, passed explicitly',
    `review effort = ${optsOf(r, 'review:412').effort}`)
  check(optsOf(r, 'fix:412').effort === 'medium', 'the fix runs at medium effort, not high', `fix effort = ${optsOf(r, 'fix:412').effort}`)
  check(optsOf(r, 'rereview:412').effort === 'medium', 'a confirming re-review runs at medium effort, not high',
    `rereview effort = ${optsOf(r, 'rereview:412').effort}`)
  check(JSON.stringify(pr0(r).effort) === JSON.stringify({ implement: 'high', review: 'high', fix: 'medium', rereview: 'medium' }),
    'the effort of every phase is reported as passed, never "inherit"', `effort = ${JSON.stringify(pr0(r).effort)}`)
  r = await run({ review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } })
  check(optsOf(r, 'rereview:412').effort === 'high' && optsOf(r, 'review:412').effort === 'high',
    'a re-review escalated from a light review runs at high effort (it is the first full-scope review)',
    `escalated rereview effort = ${optsOf(r, 'rereview:412').effort}, light review effort = ${optsOf(r, 'review:412').effort}`)
  check(optsOf(r, 'fix:412').effort === 'medium' && pr0(r).effort?.rereview === 'high',
    'after a light review the fix is still medium and the escalated re-review reports "high"')
  r = await run()
  check(r.dispatches.every((d) => d.effort === 'high') && JSON.stringify(pr0(r).effort) === JSON.stringify({ implement: 'high', review: 'high' }),
    'a clean run passes high effort on both dispatches and reports both as "high", none as "inherit"')

  // --- --small-effort (#96): the effort of the small tier's implementer, and nothing else.
  // Default high, so a run without the flag is unchanged until a replay measures medium.
  {
    const lane0 = (x) => x.result.batches[0]
    const otherEfforts = (x) => JSON.stringify(['review:412', 'fix:412', 'rereview:412'].map((l) => optsOf(x, l).effort))
    for (const [argv, facts, want, name] of [
      ['412 --small', SMALL_ISSUE, 'high', 'with no --small-effort a small-tier implementer stays at high'],
      ['412 --points 1', SMALL_ISSUE, 'high', 'with no --small-effort a 1-point implementer stays at high'],
      ['412 --small --small-effort high', SMALL_ISSUE, 'high', '--small-effort high keeps a small-tier implementer at high'],
      ['412 --small --small-effort medium', SMALL_ISSUE, 'medium', '--small-effort medium drops a --small implementer to medium'],
      ['412 --points 2 --small-effort=medium', SMALL_ISSUE, 'medium', '--small-effort=medium drops a 2-point implementer to medium'],
      ['412 --small --small-model inherit --small-effort medium', SMALL_ISSUE, 'medium', '--small-effort medium applies to the small tier on the session model too'],
      ['412 --points 3 --small-effort medium', MEDIUM_ISSUE, 'high', '--small-effort medium leaves a 3-point implementer at high'],
      ['412 --small-effort medium', MEDIUM_ISSUE, 'high', '--small-effort medium leaves an unsized implementer at high'],
    ]) {
      const baseArgv = argv.replace(/\s--small-effort(=|\s+)\S+/, '')
      const got = await run({ argv, review: BLOCKING_REVIEW, facts: { 412: facts } })
      const base = await run({ argv: baseArgv, review: BLOCKING_REVIEW, facts: { 412: facts } })
      check(optsOf(got, 'implement:412').effort === want && pr0(got).effort?.implement === want && lane0(got).implementEffort === want,
        `${name} (dispatch, PR result and batch result agree)`,
        `${name} — dispatch=${optsOf(got, 'implement:412').effort} pr=${pr0(got).effort?.implement} lane=${lane0(got).implementEffort}`)
      check(otherEfforts(got) === otherEfforts(base) && modelOf(got.dispatches, 'implement:412') === modelOf(base.dispatches, 'implement:412'),
        `${argv}: review, fix and re-review effort and the implementer's model are exactly as without --small-effort`,
        `${argv}: ${otherEfforts(got)} vs ${otherEfforts(base)}`)
      check(typeof lane0(got).implementEffortWhy === 'string' && lane0(got).implementEffortWhy.length > 0
        && got.logs.some((l) => l.startsWith('Implement ') && l.includes(`at ${want} effort`)),
        `${argv}: the implement effort's reason is recorded on the batch and the effort is logged`)
    }
    let x = await run({ argv: '412 --small --small-effort medium' })
    check(/--small-effort medium/.test(lane0(x).implementEffortWhy) && /small tier/.test(lane0(x).implementEffortWhy),
      'the recorded reason names the small tier and the flag', lane0(x).implementEffortWhy)
    x = await run({ argv: '412 --small' })
    check(/default/.test(lane0(x).implementEffortWhy), 'with no flag the recorded reason says the small tier kept the default', lane0(x).implementEffortWhy)
    x = await run({ argv: '412 --points 5 --small-effort medium' })
    check(/not the small tier/.test(lane0(x).implementEffortWhy), 'a non-small issue records that it is not the small tier', lane0(x).implementEffortWhy)
    // Concurrent batches: the flag applies per batch, by that batch's own size hint.
    x = await run({ argv: '412 --small ; 500 --points 5 --small-effort medium' })
    check(optsOf(x, 'implement:412').effort === 'medium' && optsOf(x, 'implement:500').effort === 'high'
      && x.result.batches[0].implementEffort === 'medium' && x.result.batches[1].implementEffort === 'high',
      'across concurrent batches only the small one\'s implementer drops to medium')
    x = await run({ argv: 'make the export honour a date range --small-effort medium --small' })
    check(x.dispatches[0].prompt.includes('this request: make the export honour a date range end to end') && optsOf(x, 'implement:task').effort === 'medium',
      '--small-effort is taken out of a description, not left in it')
    // An implementer that opened no PR still has its effort on the batch.
    x = await run({ argv: '412 --small --small-effort medium', implement: { issues: [{ issue: 412, pr: null, ...SMALL_ISSUE, headRefName: null, report: 'blocked' }] } })
    check(lane0(x).implementEffort === 'medium', 'a batch with no PR still records its implement effort')
    for (const bad of ['412 --small-effort low', '412 --small-effort', '412 --small-effort=', '412 --small-effort constructor', '412 --small-effort inherit']) {
      let threw = null, dispatched = 0
      try { const y = await run({ argv: bad }); dispatched = y.dispatches.length } catch (e) { threw = e.message }
      check(threw && /--small-effort must be one of medium, high/.test(threw) && dispatched === 0,
        `an invalid --small-effort ("${bad}") fails loudly at start and dispatches nothing`, `"${bad}": threw=${threw} dispatched=${dispatched}`)
    }
    // cost-report shows the implement effort and its reason, from the batch, on the Implement row.
    const cr = await import(join(ROOT, 'scripts/cost-report.mjs'))
    x = await run({ argv: '412 --small --small-effort medium' })
    const out = cr.render(cr.summarise([{ id: 'eff', data: x.result }]))
    check(/^1\s+#412\s+-\s+Implement\s+\S.*\smedium\s+sonnet\s+n\/a\s+.*--small-effort medium/m.test(out),
      'the cost-report shows the implement effort and why on the Implement row', out.split('\n').slice(0, 4).join(' | '))
    x = await run({ argv: '412 --small --small-effort medium', implement: { issues: [{ issue: 412, pr: null, ...SMALL_ISSUE, headRefName: null, report: 'blocked' }] } })
    check(/^1\s+#412\s+-\s+Implement\s+\S.*\smedium\s+sonnet\s/m.test(cr.render(cr.summarise([{ id: 'nopr', data: x.result }]))),
      'the cost-report shows the implement effort of a batch that opened no PR')
    const docs = ['README.md', 'docs/usage.md', 'docs/customising.md'].map((f) => readFileSync(join(ROOT, f), 'utf8'))
    const meta = extractMeta(src)
    check(/--small-effort medium\|high/.test(meta) && docs.every((d) => /--small-effort/.test(d))
      && /--small-effort[\s\S]{0,600}(unmeasured|not (yet )?measured)/.test(docs[2]),
      'whenToUse, README, usage and customising document --small-effort, and customising says it is unmeasured')
  }

  // --- output tokens per phase, as budget.spent() deltas
  r = await run({ review: BLOCKING_REVIEW, budget: 'metered' })
  check(JSON.stringify(pr0(r).outputTokens) === JSON.stringify({ review: 200, fix: 30, rereview: 4 })
    && r.result.batches[0].outputTokens?.implement === 1000,
  'output tokens per phase are budget.spent() deltas around each call',
  `pr=${JSON.stringify(pr0(r).outputTokens)} lane=${JSON.stringify(r.result.batches[0].outputTokens)}`)
  for (const [name, budget] of [['undefined', undefined], ['null', null], ['without spent()', { total: null }],
    ['whose spent() throws', { total: null, spent: () => { throw new Error('no') } }]]) {
    const msg = `with budget ${name}, output tokens are null and the run completes`
    try {
      r = await run({ review: BLOCKING_REVIEW, budget })
      check(r.phases.includes('Re-review') && r.result.batches[0].outputTokens?.implement === null
        && JSON.stringify(pr0(r).outputTokens) === JSON.stringify({ review: null, fix: null, rereview: null }), msg,
      `${msg} — got ${JSON.stringify(pr0(r).outputTokens)}`)
    } catch (e) { check(false, msg, `${msg} — threw: ${e.message}`) }
  }

  // --- finding counts by severity, from the structured output
  const ZERO = { critical: 0, high: 0, medium: 0, low: 0, nit: 0 }
  r = await run({ review: (o) => (o.label.startsWith('rereview:') ? CLEAN_REVIEW : BLOCKING_REVIEW) })
  check(JSON.stringify(pr0(r).findingCounts) === JSON.stringify({ review: { ...ZERO, high: 1 }, rereview: { ...ZERO, nit: 1 } }),
    'finding counts by severity are reported for the review and the re-review',
    `findingCounts = ${JSON.stringify(pr0(r).findingCounts)}`)
  r = await run()
  check(JSON.stringify(pr0(r).findingCounts) === JSON.stringify({ review: { ...ZERO, nit: 1 }, rereview: null }),
    'with no re-review, its finding counts are null')

  // --- finding confidence (#65): non-blocking findings below the threshold are dropped and
  // counted; a blocking finding is never dropped, whatever its confidence.
  {
    const conf = r0 => r0.dispatches.find((d) => d.label === 'review:412')?.schema?.properties?.findings?.items
    r = await run()
    const it = conf(r)
    check(it?.properties?.confidence?.type === 'integer' && it.properties.confidence.minimum === 0
      && it.properties.confidence.maximum === 100 && it.required.includes('confidence'),
    'every review finding carries a required integer confidence from 0 to 100')
    const f = (summary, blocking, confidence) => ({ severity: blocking ? 'high' : 'nit', location: 'a.ts:1', summary, blocking, ...(confidence === undefined ? {} : { confidence }) })
    r = await run({ review: (o) => (o.label.startsWith('rereview:') ? CLEAN_REVIEW
      : { ...CLEAN_REVIEW, blocking: false, findings: [f('SENTINEL-BLOCKER-AT-10', true, 10)] }) })
    const fx = r.dispatches.find((d) => d.label === 'fix:412')?.prompt || ''
    check(r.phases.includes('Fix') && pr0(r).blockingFindings === true && fx.includes('[BLOCKING] high a.ts:1: SENTINEL-BLOCKER-AT-10')
      && pr0(r).review.findings.length === 1 && pr0(r).suppressedFindings === 0,
    'a blocking finding at confidence 10 is still reported, reaches the fix, and still blocks')
    r = await run({ review: (o) => (o.label.startsWith('rereview:')
      ? { ...CLEAN_REVIEW, findings: [f('SENTINEL-RR-LOW', false, 5), f('rr-kept', false, 90)] }
      : { ...BLOCKING_REVIEW, findings: [f('real blocker', true, 95), f('SENTINEL-LOW-CONF', false, 20),
        f('kept at threshold', false, 50), f('kept, no confidence', false)] }) })
    const fx2 = r.dispatches.find((d) => d.label === 'fix:412')?.prompt || ''
    check(!fx2.includes('SENTINEL-LOW-CONF') && fx2.includes('kept at threshold') && fx2.includes('kept, no confidence')
      && !JSON.stringify(pr0(r).review).includes('SENTINEL-LOW-CONF'),
    'a non-blocking finding below the threshold is dropped; one at the threshold, or with no confidence, is kept')
    check(pr0(r).suppressedFindings === 2 && !JSON.stringify(pr0(r).reReview).includes('SENTINEL-RR-LOW')
      && pr0(r).findingCounts.review.nit === 2 && pr0(r).findingCounts.rereview.nit === 1,
    'suppressed findings from the review and the re-review are counted in the result, not discarded silently',
    `suppressedFindings = ${pr0(r).suppressedFindings}, findingCounts = ${JSON.stringify(pr0(r).findingCounts)}`)
    check(r.logs.some((l) => /#412: 1 non-blocking finding\(s\) below confidence 50 suppressed/.test(l)), 'a suppression is logged with the threshold')
    check(/const CONFIDENCE_THRESHOLD = 50\n/.test(src) && /measured by the #92 eval matrix \(docs\/benchmarks\.md/.test(src)
      && /### Results at #92/.test(readFileSync(join(ROOT, 'docs/benchmarks.md'), 'utf8')),
      'the threshold and its source (the #92 eval matrix, whose results docs/benchmarks.md records) are in the code comment')
    r = await run()
    check(pr0(r).suppressedFindings === 0, 'a run with nothing below the threshold records suppressedFindings 0')
    const cr = await import(join(ROOT, 'scripts/cost-report.mjs'))
    const out = cr.render(cr.summarise([{ id: 'conf', data: r.result }].map((x) => ({ ...x, data: { ...x.data,
      batches: [{ ...x.data.batches[0], prs: [{ ...x.data.batches[0].prs[0], suppressedFindings: 3 }] }] } }))))
    check(/^1\s+#412\s+#1412\s+Review\s.*3 suppressed$/m.test(out) && /^  suppressed\s+3 low-confidence non-blocking findings$/m.test(out),
      'the cost-report shows the suppressed count on the PR\'s Review row and in the totals', out.split('\n').slice(0, 6).join(' | '))
  }

  // --- a partial fix entry names what is missing rather than printing undefined
  r = await run({ review: BLOCKING_REVIEW, fix: { changed: [{ finding: 'x' }], declined: [{}], gates: FIX_RESULT.gates } })
  check(rrPrompt(r).includes('- fixed: x — (not reported) (test: (not reported))')
    && rrPrompt(r).includes('- declined: (not reported) — (not reported)') && !rrPrompt(r).includes('undefined'),
  'a partial fix entry reaches the re-review as "(not reported)", never "undefined"')

  // --- batches
  r = await run({ argv: '412 413 415' })
  check(r.dispatches.filter((d) => d.label?.startsWith('implement:')).length === 1
    && ['review:412', 'review:413', 'review:415'].every((l) => r.dispatches.some((d) => d.label === l))
    && r.result.batches[0].prs.length === 3,
  'a batch is one implementer and one review per PR')
  check(r.dispatches.every((d) => !d.isolation), 'a single batch runs in the caller checkout (no worktree)')
  check(r.dispatches[0].prompt.includes('never combine two issues in one PR'), 'a batch is told one PR per issue')

  r = await run({ argv: '412 413 415', implement: { issues: [412, 413].map((n) => ({ issue: n, pr: n + 1000, ...MEDIUM_ISSUE, report: 'x' })) } })
  check(r.result.reviewCompleted === false && JSON.stringify(r.result.batches[0].notImplemented) === '[415]'
    && r.logs.some((l) => l.startsWith('#415:')),
  'an issue the implementer did not report is named and the run is not reviewed')

  r = await run({ implement: { issues: [{ issue: 412, pr: null, ...MEDIUM_ISSUE, report: 'blocked' }] } })
  check(r.result.reviewCompleted === false && !r.dispatches.some((d) => d.label?.startsWith('review:')),
    'an issue with no PR is reported as unreviewed')

  r = await run({ argv: '412 413 ; 500 501 --small', review: BLOCKING_REVIEW })
  const impls = r.dispatches.filter((d) => d.label?.startsWith('implement:'))
  check(impls.length === 2 && r.result.batches.length === 2, 'two ;-separated batches get one implementer each')
  check(r.dispatches.every((d) => d.isolation === 'worktree'), 'concurrent batches put every agent in its own worktree')
  check(r.dispatches.every((d) => d.prompt.includes('own git worktree')), 'every isolated agent is told how to share branches')
  check(modelOf(r.dispatches, 'implement:412+413') === null && modelOf(r.dispatches, 'implement:500+501') === 'sonnet',
    'size hints apply to their own batch')
  check(r.result.batches.every((b) => b.prs.every((p) => p.reReview)), 'every PR in every batch gets its review cycles')

  // --- durable findings become suggested project notes (#67): collected, deduplicated,
  // returned as a suggestion, and never written: no prompt tells an agent to edit the
  // project's instruction files.
  {
    const durable = (o) => {
      if (o.label === 'review:412') return { ...CLEAN_REVIEW, durableFinding: 'Scoped queries must filter on tenant_id.' }
      if (o.label === 'review:413') return { ...BLOCKING_REVIEW, durableFinding: '  scoped queries must filter on\n tenant_id. ' }
      if (o.label === 'rereview:413') return { ...CLEAN_REVIEW, durableFinding: 'The in-memory fixture hides missing indexes.' }
      return CLEAN_REVIEW
    }
    r = await run({ argv: '412 413 415', review: durable })
    check(JSON.stringify(r.result.suggestedProjectNotes) === JSON.stringify(['Scoped queries must filter on tenant_id.', 'The in-memory fixture hides missing indexes.']),
      'durable findings from reviews and re-reviews across the run become suggestedProjectNotes, deduplicated',
      `suggestedProjectNotes = ${JSON.stringify(r.result.suggestedProjectNotes)}`)
    r = await run({ argv: '412 ; 500 ; 600', review: (o) => (o.label === 'review:500' ? { ...CLEAN_REVIEW, durableFinding: 'scoped queries must filter on TENANT_ID.' }
      : o.label === 'review:600' ? { ...CLEAN_REVIEW, durableFinding: 'Second batch only.' }
        : { ...CLEAN_REVIEW, durableFinding: 'Scoped queries must filter on tenant_id.' }) })
    check(JSON.stringify(r.result.suggestedProjectNotes) === '["Scoped queries must filter on tenant_id.","Second batch only."]',
      'notes are collected from every concurrent batch and deduplicated across them',
      `suggestedProjectNotes = ${JSON.stringify(r.result.suggestedProjectNotes)}`)
    r = await run({ review: { ...CLEAN_REVIEW, durableFinding: 'x'.repeat(2000) } })
    check(r.result.suggestedProjectNotes.length === 1 && r.result.suggestedProjectNotes[0].length <= 500, 'a note is capped at 500 characters')
    r = await run()
    check(Array.isArray(r.result.suggestedProjectNotes) && r.result.suggestedProjectNotes.length === 0,
      'a run in which no review returned a durable finding yields an empty list, not a placeholder')
    r = await run({ review: { ...CLEAN_REVIEW, durableFinding: '   ' } })
    check(JSON.stringify(r.result.suggestedProjectNotes) === '[]', 'a blank durable finding is not a note')
    r = await run({ review: null })
    check(JSON.stringify(r.result.suggestedProjectNotes) === '[]', 'a review that never returned adds no note and does not throw')
    check(/nothing was written to either/.test(r.result.note), 'the result says the notes were not written anywhere')
    // No dispatched prompt, in any workflow or route, instructs editing CLAUDE.md, AGENTS.md or
    // .claude/delivery.md. The matcher is proven able to fail on a prompt that does.
    const PROTECTED_RE = /(?<!\b(?:not|never|no|n't) )\b(edit|edits|editing|write|writes|writing|modify|modifies|update|updates|append|appends|add|adds|record|records|save|saves|put|puts|commit|commits|amend|amends|store|stores|log|logs)\b[^.\n]{0,80}(CLAUDE\.md|AGENTS\.md|\.claude\/delivery\.md)/i
    const PROTECTED = { test: (t) => PROTECTED_RE.test(t.replace(/\b(?:e\.g|i\.e)\./gi, 'eg')), exec: (t) => PROTECTED_RE.exec(t.replace(/\b(?:e\.g|i\.e)\./gi, 'eg')) }
    check(PROTECTED.test('Then update CLAUDE.md with the lesson.') && PROTECTED.test('Append the durable finding to .claude/delivery.md')
      && PROTECTED.test('add it to AGENTS.md') && ['Add the durable finding to CLAUDE.md.', 'Add a line to CLAUDE.md', 'Record the lesson in CLAUDE.md', 'Save it to AGENTS.md',
      'Put the note in .claude/delivery.md', 'Commit the finding to CLAUDE.md', 'Amend CLAUDE.md', 'Add a note (e.g. a lesson) to CLAUDE.md.'].every((t) => PROTECTED.test(t))
      && !PROTECTED.test('Your procedure\'s Step 0 says how to treat CLAUDE.md, AGENTS.md')
      && ['Do not edit CLAUDE.md.', 'Never write to AGENTS.md.', 'You must not add notes to CLAUDE.md'].every((t) => !PROTECTED.test(t)),
    'the instruction-file guard matches an instruction to edit them and not a mention of them')
    const planBody = readFileSync(join(ROOT, 'workflows/plan-epic.js'), 'utf8').replace(/export const meta = \{[\s\S]*?\n\}\n/, '')
    const prompts = []
    for (const opts of [{}, { review: BLOCKING_REVIEW }, { review: BLOCKING_REVIEW, facts: { 412: SMALL_ISSUE } },
      { argv: '412 413 ; 500 501', review: BLOCKING_REVIEW }, { argv: 'make the export honour a date range' }, { review: durable, argv: '412 413' }]) {
      prompts.push(...(await run(opts)).dispatches.map((d) => d.prompt))
    }
    prompts.push(...(await runner(planBody)({ argv: 'a topic' })).dispatches.map((d) => d.prompt))
    const offending = prompts.filter((t) => PROTECTED.test(t))
    check(prompts.length >= 20 && offending.length === 0,
      `no workflow prompt instructs editing CLAUDE.md, AGENTS.md or .claude/delivery.md (${prompts.length} prompts checked)`,
      `a workflow prompt instructs editing an instruction file: ${offending.map((t) => PROTECTED.exec(t)[0]).join(' | ')}`)
  }

  // --- --batch-review, the cheap mode (#66): off by default; with it, one review covers a batch
  // with no risk label, and a PR it blocks still gets its own fix and re-review.
  {
    const reviewsOf = (x) => x.dispatches.filter((d) => d.agentType === 'delivery:code-review' && d.phase === 'Review')
    r = await run({ argv: '412 413 415' })
    check(JSON.stringify(reviewsOf(r).map((d) => d.label)) === '["review:412","review:413","review:415"]'
      && r.result.cheapMode === false && r.result.batches[0].reviewMode === 'per-pr' && !r.logs.some((l) => /batch review/i.test(l)),
    'without --batch-review a batch still gets one review per PR, and the result records cheapMode false')
    const perPr = (o) => (o.label.startsWith('review:batch:') ? { reviews: [1412, 1413, 1415].map((pr) =>
      ({ ...(pr === 1413 ? BLOCKING_REVIEW : CLEAN_REVIEW), pr })) } : o.label === 'review:413' ? BLOCKING_REVIEW : CLEAN_REVIEW)
    r = await run({ argv: '412 413 415 --batch-review', review: perPr })
    const one = reviewsOf(r)
    check(one.length === 1 && one[0].label === 'review:batch:412+413+415' && one[0].schema?.properties?.reviews
      && ['#1412', '#1413', '#1415'].every((n) => one[0].prompt.includes(`PR ${n}`)) && /Publish a separate review on EACH pull request/.test(one[0].prompt)
      && one[0].effort === 'high' && one[0].model === undefined,
    'with --batch-review one full-scope review on the session model covers every PR in the batch and publishes on each')
    check(JSON.stringify(r.dispatches.filter((d) => /^(fix|rereview):/.test(d.label)).map((d) => d.label)) === '["fix:413","rereview:413"]'
      && r.result.batches[0].prs.every((p) => p.reviewCompleted && p.reviewedInBatch)
      && r.result.batches[0].prs.find((p) => p.issue === 413).stillBlocking === false,
    'a PR the batch review blocks still gets its own fix and re-review; the others do not')
    check(r.result.cheapMode === true && r.result.batches[0].reviewMode === 'batch' && /no risk label/.test(r.result.batches[0].reviewModeWhy),
      'the result records that cheap mode was used, per run and per batch')
    check(!r.dispatches.some((d) => d.prompt.includes('--batch-review')) && JSON.stringify(r.result.batches[0].issues) === '[412,413,415]',
      '--batch-review is taken out of the issue list and no prompt')
    r = await run({ argv: '412 413 415 --batch-review', review: perPr, facts: { 413: { labels: ['enhancement', 'Breaking'] } } })
    check(reviewsOf(r).length === 3 && r.result.batches[0].reviewMode === 'per-pr' && /risk label Breaking on #413/.test(r.result.batches[0].reviewModeWhy)
      && r.logs.some((l) => /--batch-review ignored: risk label Breaking on #413/.test(l)),
    'a batch with any risk-labelled issue ignores --batch-review and reviews per PR')
    r = await run({ argv: '412 413 --batch-review', review: perPr, facts: { 412: { labels: null } } })
    check(reviewsOf(r).length === 2 && r.result.batches[0].reviewMode === 'per-pr', 'unknown labels in a batch also mean one review per PR')
    r = await run({ argv: '412 --batch-review', review: perPr })
    check(reviewsOf(r).map((d) => d.label).join() === 'review:412', 'a single PR is reviewed on its own even with --batch-review')
    r = await run({ argv: '412 413 --batch-review', review: (o) => ({ reviews: [{ ...CLEAN_REVIEW, pr: 1412 }] }) })
    const p413 = r.result.batches[0].prs.find((p) => p.issue === 413)
    check(p413?.reviewCompleted === false && r.result.reviewCompleted === false && r.logs.some((l) => /#413: review did not complete/.test(l)),
      'a PR the batch review returned nothing for is reported as not reviewed')
    r = await run({ argv: '412 413 --batch-review', review: null })
    check(r.result.batches[0].prs.every((p) => p.reviewCompleted === false) && !r.phases.includes('Fix'),
      'a batch review that never returned marks every PR in the batch unreviewed')
    r = await run({ argv: '412 413 --batch-review', review: perPr, budget: 'metered' })
    check(r.result.batches[0].outputTokens.batchReview === 200 && r.result.batches[0].prs.every((p) => !('review' in p.outputTokens)),
      'the batch review\'s output tokens are recorded once, on the batch, not split across its PRs')
    const para = readFileSync(join(ROOT, 'README.md'), 'utf8').split(/\n\s*\n/).find((x) => x.includes('review phase cannot be skipped')) || ''
    check(/--batch-review/.test(para) && /experimental/i.test(para) && /risk label/.test(para),
      'the README states the --batch-review trade-off next to "the review phase cannot be skipped"')
    const cr = await import(join(ROOT, 'scripts/cost-report.mjs'))
    const out = cr.render(cr.summarise([{ id: 'cheap', data: r.result }]))
    check(/cheap mode: one review per batch \(--batch-review\)/.test(out) && /^1\s+#412,#413\s+-\s+Batch review\s+200\s/m.test(out)
      && /^1\s+#412\s+#1412\s+Review\s+n\/a\s.*in batch review$/m.test(out),
    'the cost-report shows cheap mode, the batch review row and which reviews it covered', out.split('\n').slice(0, 7).join(' | '))
  }

  r = await run({ argv: '412, 413' })
  check(r.dispatches.some((d) => d.label === 'implement:412+413'), 'comma-separated issues are a batch')

  r = await run({ argv: '412 ; 412' })
  check(r.dispatches.filter((d) => d.label?.startsWith('implement:')).length === 1, 'an issue listed twice is worked once')

  r = await run({ argv: 'fix the export, then the filter --small' })
  check(r.dispatches[0].prompt.includes('this request: fix the export, then the filter end to end')
    && modelOf(r.dispatches, 'implement:task') === 'sonnet',
  'a description keeps its punctuation and loses only the hint flag')

  r = await run({ argv: 'fix the export; then the filter' })
  check(r.result.batches.length === 1 && r.result.batches[0].issues.length === 0 && r.dispatches.every((d) => !d.isolation),
    'a description containing ; is one request, not batches')
}

// --------------------------------------------------------------- cost-report
// scripts/cost-report.mjs against the synthetic fixtures. Each check guards one
// rule of the report; the totals are recomputed here from the fixture files, so
// the script's arithmetic is not checked against itself.
console.log('\n== scripts/cost-report.mjs ==')
{
  const SCRIPT = join(ROOT, 'scripts/cost-report.mjs')
  const FIX = join(ROOT, 'scripts/fixtures/cost-report')
  const c = (cond, msg) => (cond ? ok(`cost-report: ${msg}`) : bad(`cost-report: ${msg}`))
  const cli = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' })
  const parse = (r) => { try { return JSON.parse(r.stdout) } catch { return null } }
  const snapshot = () => readdirSync(FIX).sort().map((f) => `${f}:${statSync(join(FIX, f)).mtimeMs}`).join('\n')

  const before = snapshot()
  const text = cli(FIX)
  const report = parse(cli('--json', FIX)) || { runs: [], unrecognised: [], trend: { phases: {} }, totals: {} }
  const withConcurrent = parse(cli('--json', '--include-concurrent', FIX)) || { trend: { phases: {} } }
  c(snapshot() === before, 'read-only: the fixture directory\'s file list and every mtime are unchanged by a run')

  const src = existsSync(SCRIPT) ? readFileSync(SCRIPT, 'utf8') : ''
  const specifiers = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] || m[2])
  c(specifiers.length > 0 && specifiers.every((s) => s.startsWith('node:')), `imports only node: builtins (${specifiers.join(', ')})`)
  c(!existsSync(join(ROOT, 'package.json')), 'no package.json is added')
  const writes = [...src.matchAll(/\b(writeFile|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|symlink|link|truncate|chmod|chown|utimes|createWriteStream|open)(Sync)?\s*\(/g)].map((m) => m[0])
  c(src && writes.length === 0, `calls no filesystem write API, so nothing is written under ~/.claude or anywhere else${writes.length ? ` (found ${writes.join(', ')})` : ''}`)

  const block = (id) => {
    const i = text.stdout.indexOf(`== ${id} `)
    if (i === -1) return ''
    const rest = text.stdout.slice(i + 1)
    const end = rest.search(/\n(== |Totals|Per-phase trend)/)
    return end === -1 ? rest : rest.slice(0, end)
  }
  const run = (id) => report.runs.find((r) => r.id === id) || { rows: [], total: {} }
  const trendRuns = (rep) => new Set(Object.values(rep.trend?.phases || {}).flat().map((e) => e.run))

  // Rule 3: a run with nothing measured totals "not measured", never 0.
  const nullRun = run('orchestrate-null-tokens.json')
  c(nullRun.total.outputTokens === null && nullRun.total.unmeasured === 4,
    `all-null tokens total as not measured with 4 phases excluded (got ${JSON.stringify(nullRun.total)})`)
  c(/total not measured \(4 phases not measured\)/.test(block('orchestrate-null-tokens.json'))
    && !/total 0\b/.test(block('orchestrate-null-tokens.json')),
    'all-null tokens print "total not measured (4 phases not measured)", not "total 0"')
  c(nullRun.rows.every((r) => r.outputTokens === null) && /not measured/.test(block('orchestrate-null-tokens.json')),
    'a null token value is "not measured" in every row')

  // Rule 5: a review that did not return is flagged and contributes no findings.
  const missRun = run('orchestrate-review-missing.json')
  const missRow = missRun.rows.find((r) => r.phase === 'Review') || {}
  c(missRow.reviewDidNotReturn === true && missRow.findings === 'n/a' && missRow.model === 'n/a',
    `the unreturned review row is flagged with n/a findings and model (got ${JSON.stringify(missRow)})`)
  c(/REVIEW DID NOT RETURN/.test(block('orchestrate-review-missing.json')), 'the unreturned review prints REVIEW DID NOT RETURN')
  const SEV = ['critical', 'high', 'medium', 'low', 'nit']
  const want = { review: Object.fromEntries(SEV.map((s) => [s, 0])), reviews: 0 }
  for (const f of readdirSync(FIX).filter((f) => f.endsWith('.json') && f !== 'orchestrate-review-missing.json')) {
    for (const b of JSON.parse(readFileSync(join(FIX, f), 'utf8')).batches || []) {
      for (const p of b.prs || []) {
        if (!p.findingCounts?.review) continue
        want.reviews++
        for (const s of SEV) want.review[s] += p.findingCounts.review[s]
      }
    }
  }
  c(JSON.stringify(report.totals.findingCounts?.review) === JSON.stringify(want.review)
    && report.totals.reviewsCounted?.review === want.reviews && report.totals.reviewsNotReturned === 1,
    `the findingCounts.review total is the other fixtures' sum over ${want.reviews} reviews, with 1 not returned ` +
    `(got ${JSON.stringify(report.totals.findingCounts?.review)}, ${report.totals.reviewsCounted?.review}, ${report.totals.reviewsNotReturned})`)

  // Rule 4: a concurrent run is marked and left out of the trend by default.
  const conc = run('orchestrate-concurrent.json')
  c(conc.concurrent === true && /CONCURRENT/.test(block('orchestrate-concurrent.json'))
    && !/CONCURRENT/.test(block('orchestrate-single.json')), 'the two-batch run, and only it, is marked CONCURRENT')
  c(!trendRuns(report).has('orchestrate-concurrent.json') && trendRuns(report).has('orchestrate-single.json')
    && report.trend.excluded?.includes('orchestrate-concurrent.json'),
    'the concurrent run\'s tokens are absent from the per-phase trend by default')
  const concImpl = (withConcurrent.trend.phases.Implement || []).find((e) => e.run === 'orchestrate-concurrent.json')
  c(concImpl?.outputTokens === 90000, `--include-concurrent puts the concurrent run back in the trend (Implement = ${concImpl?.outputTokens})`)

  // Rule 2: plan-epic records tokens only, so the rest is n/a.
  const plan = run('plan-epic.json')
  const pr = (p) => plan.rows.find((r) => r.phase === p) || {}
  c(plan.workflow === 'plan-epic' && pr('Research').outputTokens === 23000 && pr('Plan').outputTokens === 14500,
    'plan-epic reports real Research and Plan tokens')
  c(plan.rows.length === 2 && plan.rows.every((r) => r.effort === 'n/a' && r.model === 'n/a' && r.findings === 'n/a')
    && /Research\s+23,000\s+n\/a\s+n\/a\s+n\/a/.test(block('plan-epic.json')),
    'plan-epic prints n/a for effort, model and findings')

  // Rule 1: an unrecognised file is skipped, and the rest still report. Found in a
  // directory it is counted on one skipped line; named on its own it gets its own line.
  c(text.status === 0 && /^skipped 1 file \(1 not a delivery result\)/m.test(text.stdout) && !/^unrecognised:/m.test(text.stdout)
    && report.runs.length === 5 && report.skipped?.[0]?.id === 'not-a-result.json',
    `an unrecognised file in a directory is counted as skipped, exit 0, and the other 5 files report (exit ${text.status}, ${report.runs.length} runs)`)
  {
    const o = cli(join(FIX, 'not-a-result.json'))
    c(o.status === 0 && /^unrecognised: not-a-result\.json$/m.test(o.stdout) && !/^skipped/m.test(o.stdout),
      `an unrecognised file named on its own still prints its own unrecognised line (exit ${o.status})`)
  }

  // Rule 6: the fixed caveat closes the output.
  const lines = text.stdout.trimEnd().split('\n')
  c(/severity counts are a proxy/i.test(lines[lines.length - 1] || '') && /Obsessive inference optimization/.test(lines[lines.length - 1] || '')
    && /severity counts are a proxy/i.test(report.caveat || ''), 'the output ends with the proxy caveat line')

  // Rule 3, with measured numbers: a run's total is the sum of what was measured.
  const single = run('orchestrate-single.json')
  c(single.total.outputTokens === 41000 + 9000 + 3200 + 1800 && single.total.unmeasured === 0
    && /total 55,000$/m.test(block('orchestrate-single.json')), `a fully measured run totals 55,000 (got ${single.total.outputTokens})`)
  c(['Implement', 'Review'].every((p) => single.rows.find((r) => r.phase === p)?.effort === 'high')
    && /^1\s+#412\s+-\s+Implement\s+41,000\s+high\s/m.test(block('orchestrate-single.json'))
    && /^1\s+#412\s+#1412\s+Review\s+9,000\s+high\s/m.test(block('orchestrate-single.json')),
    'a run with explicit high effort prints high in the effort column for Implement and Review')

  // The contract: a single file path works, and summarise() is exported.
  const one = parse(cli('--json', join(FIX, 'plan-epic.json')))
  c(one?.runs?.length === 1 && one.runs[0].id === 'plan-epic.json', 'a single file path is accepted')
  try {
    const { summarise } = await import(SCRIPT)
    const r = summarise([{ id: 'x.json', data: { foo: 1 } }], {})
    c(r.runs.length === 0 && r.unrecognised.includes('x.json'), 'summarise() is exported and skips an unrecognised shape')
  } catch (e) { c(false, `summarise() import threw — ${e.message}`) }
  try {
    const { summarise } = await import(SCRIPT)
    const nul = { batches: [{ issues: [1], outputTokens: { implement: 1 }, prs: [{ reviewCompleted: true,
      outputTokens: { review: 1, rereview: 1 }, findingCounts: { review: { critical: 0, high: 1, medium: 0, low: 0, nit: 0 }, rereview: null } }] }] }
    const r = summarise([{ id: 'n.json', data: nul }], {})
    c(r.runs.length === 1 && r.totals.reviewsCounted.rereview === 0 && r.totals.reviewsCounted.review === 1,
      'a ran-but-null findingCounts (re-review) does not crash and is not counted')
  } catch (e) { c(false, `null findingCounts crashed summarise() — ${e.message}`) }
  {
    const d = join(tmpdir(), `cr-dangling-${process.pid}`)
    rmSync(d, { recursive: true, force: true }); mkdirSync(d)
    symlinkSync(join(d, 'missing.json'), join(d, 'dangling.json'))
    copyFileSync(join(FIX, 'plan-epic.json'), join(d, 'plan-epic.json'))
    const o = cli('--json', d)
    c(o.status === 1 && /cannot read .*dangling\.json/.test(o.stderr || '') && parse(o)?.runs?.length === 1,
      `a dangling symlink in a directory is reported on stderr, exit 1, and the other file still reports (exit ${o.status})`)
    rmSync(d, { recursive: true, force: true })
  }

  // Two same-named files in different directories are two runs, not one id twice.
  {
    const IDS = join(ROOT, 'scripts/fixtures/cost-report-ids')
    const o = parse(cli('--json', join(IDS, 'a'), join(IDS, 'b')))
    const ids = (o?.runs || []).map((r) => r.id)
    const trendIds = Object.values(o?.trend?.phases || {}).flat().map((e) => e.run)
    c(JSON.stringify(ids) === JSON.stringify(['a/result.json', 'b/result.json'])
      && trendIds.includes('a/result.json') && trendIds.includes('b/result.json'),
      `same-named files in two directories get distinct ids, relative to their common directory (got ${JSON.stringify(ids)})`)
    const t = cli(join(IDS, 'a'), join(IDS, 'b')).stdout
    c(/^== a\/result\.json \(plan-epic\) ==$/m.test(t) && /^== b\/result\.json \(orchestrate\) ==$/m.test(t),
      'the table heads each same-named run with its distinct id')

    // Inputs with no common directory below / keep short ids, not near-absolute paths.
    const d = realpathSync(tmpdir())
    const far = join(d, `cr-far-${process.pid}`)
    rmSync(far, { recursive: true, force: true }); mkdirSync(far)
    copyFileSync(join(IDS, 'a', 'result.json'), join(far, 'result.json'))
    const top = (p) => p.split(sep).filter(Boolean)[0]
    if (top(far) !== top(realpathSync(IDS))) {
      const f = (parse(cli('--json', join(IDS, 'a', 'result.json'), join(far, 'result.json')))?.runs || []).map((r) => r.id)
      c(JSON.stringify(f) === JSON.stringify(['a/result.json', `${basename(far)}/result.json`]),
        `inputs under different top-level directories get their shortest unique suffix as id (got ${JSON.stringify(f)})`)
    } else {
      // In CI the checkout and tmpdir are on different top-level directories, so a
      // SKIP there means the check silently stopped running.
      const msg = `cost-report: shortest-unique-suffix ids: ${far} and ${IDS} share a top-level directory, so this checkout cannot exercise it`
      process.env.CI ? bad(`${msg} (CI is set, so a skip is a failure)`) : skip(msg)
    }

    // Two spellings of one directory are one id: a symlink, and on macOS the
    // unresolved tmpdir (/var/... or /tmp/...) beside its /private realpath.
    const alias = join(d, `cr-alias-${process.pid}`)
    rmSync(alias, { force: true }); symlinkSync(far, alias)
    const spellings = [join(alias, 'result.json'), join(far, 'result.json')]
    if (tmpdir() !== d) spellings.push(join(tmpdir(), basename(far), 'result.json'))
    const s = (parse(cli('--json', ...spellings))?.runs || []).map((r) => r.id)
    c(s.length === spellings.length && s.every((id) => id === 'result.json'),
      `${spellings.length} spellings of the same file get the same id (got ${JSON.stringify(s)})`)
    rmSync(alias, { force: true }); rmSync(far, { recursive: true, force: true })
  }

  // A finished workflow's task output wraps the result: `result` is the object, or
  // a JSON string of it. The wrapper's own id names the run; a wrapper around
  // anything else is still unrecognised. A directory contributes *.output files too.
  {
    const WRAP = join(ROOT, 'scripts/fixtures/cost-report-wrapped')
    const snap = () => readdirSync(WRAP).sort().map((f) => `${f}:${statSync(join(WRAP, f)).mtimeMs}`).join('\n')
    const pre = snap()
    const o = cli('--json', WRAP)
    const w = parse(o) || { runs: [], unrecognised: [] }
    const t = cli(WRAP).stdout
    c(snap() === pre, 'read-only: the wrapped fixture directory\'s file list and every mtime are unchanged by a run')
    const byId = Object.fromEntries(w.runs.map((r) => [r.id, r]))
    c(o.status === 0 && byId['wf-object-0001']?.workflow === 'orchestrate' && byId['wf-object-0001'].total.outputTokens === 41000 + 9000 + 3200 + 1800,
      `a wrapper whose result is an object reports that result, named by the wrapper's taskId (got ${JSON.stringify(w.runs.map((r) => [r.id, r.workflow]))})`)
    c(byId['02-string.output']?.workflow === 'plan-epic' && byId['02-string.output'].rows.find((r) => r.phase === 'Research')?.outputTokens === 23000,
      'a wrapper whose result is a JSON string reports the parsed result, named by its file when it carries no id')
    c(JSON.stringify((w.skipped || []).map((x) => x.id)) === JSON.stringify(['03-not-a-result.output']) && w.unrecognised.length === 0
      && /^skipped 1 file \(1 not a delivery result\)/m.test(t),
      `a wrapper whose result is not a workflow result is still not reported as a run (got skipped ${JSON.stringify(w.skipped)})`)
    c(/^== wf-object-0001 \(orchestrate\) ==$/m.test(t) && (w.trend?.phases?.Implement || []).some((e) => e.run === 'wf-object-0001'),
      'the trend reads by the wrapper\'s run id, not its file name')
    const bare = parse(cli('--json', join(FIX, 'plan-epic.json')))
    c(bare?.runs?.[0]?.id === 'plan-epic.json' && bare.runs[0].workflow === 'plan-epic', 'a bare result still reports exactly as before')
  }

  // Run order: file names sort a-later before b-earlier, start times the other way.
  {
    const ORD = join(ROOT, 'scripts/fixtures/cost-report-order')
    const o = parse(cli('--json', ORD))
    const t = cli(ORD).stdout
    c(JSON.stringify((o?.runs || []).map((r) => r.id)) === JSON.stringify(['wf_order-earlier', 'wf_order-later'])
      && o.trend.order === 'start time' && /^Per-phase trend \(by start time\)$/m.test(t)
      && t.indexOf('== wf_order-earlier ') < t.indexOf('== wf_order-later '),
      `runs that all carry a start time are reported in start-time order, and the trend header says so (got ${JSON.stringify((o?.runs || []).map((r) => r.id))})`)
    const mixed = parse(cli('--json', join(ORD, 'a-later.output'), join(FIX, 'plan-epic.json'), join(ORD, 'b-earlier.output')))
    const mt = cli(join(ORD, 'a-later.output'), join(FIX, 'plan-epic.json'), join(ORD, 'b-earlier.output')).stdout
    c(JSON.stringify((mixed?.runs || []).map((r) => r.id)) === JSON.stringify(['wf_order-later', 'cost-report/plan-epic.json', 'wf_order-earlier'])
      && mixed.trend.order === 'input' && /^Per-phase trend \(in input order\)$/m.test(mt),
      `when one run has no start time, runs keep their input order and the trend header says so (got ${JSON.stringify((mixed?.runs || []).map((r) => r.id))})`)
  }

  // A directory of unrelated files: one summary line, nothing on stderr; --verbose
  // lists them. A named file still gets its own line, and an unreadable one exits 1.
  {
    const SK = join(ROOT, 'scripts/fixtures/cost-report-skipped')
    const o = cli(SK)
    const lines = o.stdout.split('\n').filter((l) => /not JSON|not a delivery result|unrecognised/.test(l))
    c(o.status === 0 && o.stderr === '' && lines.length === 1
      && /^skipped 4 files \(2 not JSON, 2 not a delivery result\); --verbose lists them$/m.test(o.stdout)
      && /^== 01-run\.json \(plan-epic\) ==$/m.test(o.stdout),
      `a directory's unrelated files collapse to one skipped line with nothing on stderr (exit ${o.status}, ${lines.length} lines, stderr ${JSON.stringify(o.stderr)})`)
    const v = cli('--verbose', SK).stdout
    c(['02-not-json.json (not JSON)', '03-transcript.output (not JSON)', '04-other-workflow.output (not a delivery result)',
      '05-not-a-result.json (not a delivery result)'].every((x) => v.includes(`  skipped: ${x}`)),
      '--verbose lists every skipped file with its reason')
    const e = cli(join(SK, '02-not-json.json'))
    c(e.status === 0 && /02-not-json\.json: not valid JSON/.test(e.stderr) && /^unrecognised: 02-not-json\.json$/m.test(e.stdout),
      `a named file that is not JSON still gets its own stderr and unrecognised lines (exit ${e.status})`)
    const m = cli(join(SK, 'no-such-file.json'), join(SK, '01-run.json'))
    c(m.status === 1 && /cannot read .*no-such-file\.json/.test(m.stderr) && /== 01-run\.json/.test(m.stdout),
      `a named file that cannot be read gets its own line and exit 1 (exit ${m.status})`)
    const wn = parse(cli('--json', join(SK, '04-other-workflow.output')))
    c(wn?.runs?.length === 0 && wn.unrecognised.length === 0 && wn.skipped?.[0]?.reason === 'not a delivery result',
      `a wrapper naming a non-delivery workflow is skipped even though its result has a delivery shape (got ${JSON.stringify(wn?.skipped)})`)
  }

  // Wrapper ids: an unsafe one, or one two inputs share, falls back to the path id.
  {
    const WI = join(ROOT, 'scripts/fixtures/cost-report-wrapped-ids')
    const o = parse(cli('--json', WI))
    const t = cli(WI).stdout
    const ids = (o?.runs || []).map((r) => r.id)
    c(JSON.stringify(ids) === JSON.stringify(['dup-1.output', 'dup-2.output', 'forged.output']),
      `a shared wrapper id and a wrapper id with a newline both fall back to the path id (got ${JSON.stringify(ids)})`)
    c(!/^== forged \(/m.test(t) && !/^unrecognised: forged$/m.test(t) && /^== forged\.output \(plan-epic\) ==$/m.test(t),
      'a taskId containing a newline forges no line of the table')
    const both = parse(cli('--json', join(WI, 'dup-1.output'), join(ROOT, 'scripts/fixtures/cost-report-order')))
    c(JSON.stringify((both?.runs || []).map((r) => r.id)) === JSON.stringify(['wf_dup-0001', 'wf_order-later', 'wf_order-earlier']),
      `a wrapper id no other input shares is kept (got ${JSON.stringify((both?.runs || []).map((r) => r.id))})`)
  }
}

// --discover: the persisted runs of the cwd's project, from a synthetic config tree.
// The tree mirrors Claude Code 2.1.308's layout; every file in it is hand-built.
console.log('\n== cost-report --discover ==')
{
  const SCRIPT = join(ROOT, 'scripts/cost-report.mjs')
  const CONF = join(ROOT, 'scripts/fixtures/cost-report')
  const PROJ = join(CONF, 'projects', '-fixture-project')
  const c = (cond, msg) => (cond ? ok(`cost-report --discover: ${msg}`) : bad(`cost-report --discover: ${msg}`))
  const parse = (r) => { try { return JSON.parse(r.stdout) } catch { return null } }
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]))
  const snap = (d) => walk(d).sort().map((f) => `${f}:${statSync(f).mtimeMs}`).join('\n')
  const RUNS = ['wf_bbbb2222-001', 'wf_aaaa1111-002', 'wf_bbbb2222-003']
  try {
    const m = await import(SCRIPT)
    c(m.projectSlug('/Users/me/dev/claude-delivery-plugin/.claude/worktrees/wf_81999d78-199-1')
      === '-Users-me-dev-claude-delivery-plugin--claude-worktrees-wf-81999d78-199-1',
      'the project slug replaces every character other than a letter or digit with -, as Claude Code names its directories')
    const { root, files } = m.discoverFiles(CONF, '/fixture/project')
    c(root === PROJ && JSON.stringify(files.map((f) => basename(f)).sort())
      === JSON.stringify(['wf_aaaa1111-002.json', 'wf_aaaa1111-004.json', 'wf_aaaa1111-005.json', 'wf_bbbb2222-001.json', 'wf_bbbb2222-003.json']),
      `only <session>/workflows/wf_*.json of the cwd's project is read: not notes.json, a transcript, a journal, a nested or another project's run (got ${JSON.stringify(files.map((f) => basename(f)))})`)
  } catch (e) { c(false, `discoverFiles() import threw — ${e.message}`) }

  const tmp = realpathSync(tmpdir())
  const cwd = realpathSync(ROOT)
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-')
  const conf = join(tmp, `cr-discover-${process.pid}`)
  rmSync(conf, { recursive: true, force: true }); mkdirSync(join(conf, 'projects'), { recursive: true })
  symlinkSync(PROJ, join(conf, 'projects', slug))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: conf }
  const cli = (e, ...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8', cwd, env: e })
  const before = snap(PROJ)
  const o = cli(env, '--json', '--discover')
  const r = parse(o)
  const ids = (r?.runs || []).map((x) => x.id)
  c(o.status === 0 && JSON.stringify(ids) === JSON.stringify(RUNS) && r.trend.order === 'start time',
    `finds exactly the three delivery runs, oldest first, named by runId (exit ${o.status}, got ${JSON.stringify(ids)})`)
  c(JSON.stringify((r?.skipped || []).map((x) => x.reason).sort()) === JSON.stringify(['not JSON', 'not a delivery result'])
    && o.stderr === '', `the non-delivery run and the unparseable file are skipped and counted, with nothing on stderr (got ${JSON.stringify(r?.skipped)})`)
  const t = cli(env, '--discover')
  c(/^skipped 2 files \(1 not JSON, 1 not a delivery result\)/m.test(t.stdout) && /^Per-phase trend \(by start time\)$/m.test(t.stdout)
    && /^== wf_bbbb2222-001 \(plan-epic\) ==$/m.test(t.stdout), 'the table reports the discovered runs and one skipped line')
  const lastIds = (parse(cli(env, '--json', '--discover', '--last', '1'))?.runs || []).map((x) => x.id)
  c(JSON.stringify(lastIds) === JSON.stringify(['wf_bbbb2222-003']), `--last 1 keeps only the newest run (got ${JSON.stringify(lastIds)})`)
  const sinceIds = (parse(cli(env, '--json', '--discover', '--since', '2026-10-21'))?.runs || []).map((x) => x.id)
  c(JSON.stringify(sinceIds) === JSON.stringify(['wf_aaaa1111-002', 'wf_bbbb2222-003']),
    `--since keeps the runs started on or after the date (got ${JSON.stringify(sinceIds)})`)
  c(snap(PROJ) === before && JSON.stringify(walk(conf).map((f) => basename(f))) === JSON.stringify([slug]),
    'read-only: the fixture tree is unchanged and nothing is added to the config directory')

  // No runs: a plain message, never an empty table that reads as zero cost.
  const empty = join(tmp, `cr-discover-empty-${process.pid}`)
  rmSync(empty, { recursive: true, force: true }); mkdirSync(empty)
  const n = cli({ ...process.env, CLAUDE_CONFIG_DIR: empty }, '--discover')
  c(n.status === 0 && n.stdout === `no runs found under ${join(empty, 'projects', slug)}\n`,
    `a root with no runs prints "no runs found under <root>" and exits 0 (exit ${n.status}, got ${JSON.stringify(n.stdout)})`)
  const home = { ...process.env, HOME: empty }
  delete home.CLAUDE_CONFIG_DIR
  const h = cli(home, '--discover')
  c(h.status === 0 && h.stdout === `no runs found under ${join(empty, '.claude', 'projects', slug)}\n`,
    `without CLAUDE_CONFIG_DIR the root is ~/.claude (got ${JSON.stringify(h.stdout)})`)
  c(readdirSync(empty).length === 0, 'nothing is created under the config root, even when it has no projects directory')
  const bads = [['--discover', join(ROOT, 'README.md')], ['--discover', '--last', '0'], ['--discover', '--since', 'yesterday'],
    ['--last', '2', join(CONF, 'plan-epic.json')], ['--discover', '--last']]
  const codes = bads.map((a) => cli(env, ...a).status)
  c(codes.every((s) => s === 2), `a path with --discover, a bad --last or --since, or either without --discover is a usage error (got ${JSON.stringify(codes)})`)
  const plain = cli(env, join(CONF, 'plan-epic.json'))
  c(plain.status === 0 && /^== plan-epic\.json \(plan-epic\) ==$/m.test(plain.stdout) && !/wf_/.test(plain.stdout),
    'without --discover only the given paths are read, even with a config tree present')
  rmSync(conf, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true })

  // A run with no start time, in the session directory that sorts last: --last
  // must still keep the newest timed runs, and the filters must say what they dropped.
  const UNTIMED = join(ROOT, 'scripts/fixtures/cost-report-untimed')
  const uconf = join(tmp, `cr-discover-untimed-${process.pid}`)
  rmSync(uconf, { recursive: true, force: true }); mkdirSync(join(uconf, 'projects'), { recursive: true })
  symlinkSync(UNTIMED, join(uconf, 'projects', slug))
  const uenv = { ...process.env, CLAUDE_CONFIG_DIR: uconf }
  const uroot = join(uconf, 'projects', slug)
  const all = parse(cli(uenv, '--json', '--discover'))
  c(JSON.stringify((all?.runs || []).map((x) => x.id))
    === JSON.stringify(['wf_untimed-none', 'wf_untimed-oldest', 'wf_untimed-middle', 'wf_untimed-newest'])
    && all?.trend?.order === 'start time' && all?.trend?.untimed === 1,
    `a run with no start time is placed first and the rest by start time (got ${JSON.stringify((all?.runs || []).map((x) => x.id))}, order ${all?.trend?.order})`)
  c(/^Per-phase trend \(by start time; 1 run without a start time placed first\)$/m.test(cli(uenv, '--discover').stdout),
    'the trend header says a run without a start time was placed first')
  const ulast = (parse(cli(uenv, '--json', '--discover', '--last', '2'))?.runs || []).map((x) => x.id)
  c(JSON.stringify(ulast) === JSON.stringify(['wf_untimed-middle', 'wf_untimed-newest']),
    `--last 2 keeps the two newest timed runs even when an untimed run's directory sorts last (got ${JSON.stringify(ulast)})`)
  const us = cli(uenv, '--discover', '--since', '2026-10-11')
  const usj = parse(cli(uenv, '--json', '--discover', '--since', '2026-10-11'))
  c(/^skipped 1 file \(1 without a start time\); --verbose lists them$/m.test(us.stdout)
    && JSON.stringify(usj?.skipped) === JSON.stringify([{ id: 'wf_untimed-none', reason: 'without a start time' }])
    && JSON.stringify((usj?.runs || []).map((x) => x.id)) === JSON.stringify(['wf_untimed-middle', 'wf_untimed-newest']),
    `--since counts the run it dropped for having no start time on the skipped line (got ${JSON.stringify(usj?.skipped)})`)
  const none = cli(uenv, '--discover', '--since', '2027-01-01')
  c(none.status === 0 && none.stdout
    === `no runs match --since 2027-01-01 (4 found under ${uroot}; skipped 1 file, --verbose lists them)\n`,
    `when --since excludes every run found, it says so rather than "no runs found" (got ${JSON.stringify(none.stdout)})`)
  rmSync(uconf, { recursive: true, force: true })
}

// The review eval suite (#59, #92) and its tier table. The graders are checked here against
// canned replies, so each is proven able to fail without spending a model call; the generated
// prompts are checked against the workflow, so the eval cannot drift from what orchestrate sends.
console.log('\n== evals/, scripts/eval-build.mjs, eval-scaffold.mjs, eval-run.mjs and eval-tiers.mjs ==')
{
  const c = (cond, msg) => (cond ? ok(`evals: ${msg}`) : bad(`evals: ${msg}`))
  const EV = join(ROOT, 'evals')
  const BATCH_NAMES = ['batch-three-prs', 'per-pr-three-prs']
  const cases = existsSync(EV) ? readdirSync(EV, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !['results', 'full'].includes(e.name) && !BATCH_NAMES.includes(e.name)).map((e) => e.name).sort() : []
  const graderIn = (dir, file) => {
    const gp = join(dir, 'graders', file)
    if (!existsSync(gp)) return null
    const fm = frontmatter(readFileSync(gp, 'utf8'), gp) || {}
    return fm.type === 'regex' ? new RegExp(fm.pattern, fm.flags || '') : null
  }
  const grader = (name) => graderIn(join(EV, name), name.startsWith('clean-') ? 'no-false-block.md' : 'found-seeded-defect.md')
  const tagsOf = (dir) => {
    const y = existsSync(join(dir, 'case.yaml')) ? readFileSync(join(dir, 'case.yaml'), 'utf8') : ''
    return (/^tags:\s*\[([^\]]*)\]/m.exec(y)?.[1] || '').split(',').map((t) => t.trim()).filter(Boolean)
  }
  // A finding line in the reply format the generated prompts ask for.
  const L = (loc, sev, conf, text, blocking = true) => `${loc} — ${sev} — ${conf} — ${blocking ? 'blocking' : 'non-blocking'} — ${text}`
  const VERDICT = '\nRecommendation: do not merge'
  const HIT = {
    'seeded-sql-injection': L('src/routes/users.js:16', 'high', 90, 'SQL injection: name is concatenated into the query; use a parameterized query'),
    'seeded-missing-tenant-scope': L('src/invoices/repository.ts:9', 'high', 90, 'getInvoice ignores tenantId, so any tenant can read another tenant\'s invoice (IDOR)'),
    'seeded-auth-bypass': L('src/middleware/auth.js:6', 'critical', 95, 'a request with no token now calls next(), so unauthenticated requests pass'),
    'seeded-secret-logged': L('src/auth/login.js:7', 'high', 90, 'the login attempt logs req.body, so every password is written to the log in plain text'),
    'seeded-secret-committed': L('src/payments/client.js:5', 'critical', 95, 'a live payment API key is hardcoded and committed; rotate it and read it from the environment'),
    'seeded-off-by-one': L('src/lib/paginate.js:4', 'high', 90, 'slice() end is exclusive, so every page returns pageSize - 1 items (off by one)'),
    'seeded-unhandled-null': L('src/routes/users.js:15', 'high', 90, 'findById returns null for an unknown id, so user.email throws a TypeError and the route 500s instead of 404'),
    'seeded-race-shared-state': L('src/accounts/withdraw.js:5', 'high', 85, 'read-check-write with no transaction or lock: two concurrent withdrawals both pass the check (race, lost update)'),
    'seeded-n-plus-one': L('src/routes/orders.js:9', 'medium', 80, 'N+1: one order_items query per order inside the loop; load them with one whereIn query'),
    'seeded-test-cannot-fail': L('test/billing.test.js:11', 'high', 90, 'the test calls its own mock and asserts on the mock\'s return value; chargeOrder is never called, so it cannot fail'),
    'seeded-wrong-branch-coverage': L('test/coupons.test.js:8', 'medium', 80, 'the new expired-coupon branch is untested; both tests use a coupon that has not expired'),
    'seeded-unmet-requirement': L('src/routes/export.js:3', 'high', 90, 'the acceptance criterion for the from/to date range is not met: the query ignores both parameters'),
    'seeded-invariant-violation': L('src/refunds/partial.js:6', 'high', 85, 'order.total * (percent / 100) is fractional for most totals, but src/ledger.js requires integer cents; round before posting'),
    'seeded-authz-moved': L('src/routes/reports.js:14', 'critical', 90, 'the payouts export moved under /reports, which src/app.js mounts with requireAuth only: any signed-in seller can download every seller\'s bank details; it lost the admin role check'),
    'seeded-race-lock-helper': L('src/inventory/reserve.js:9', 'high', 85, 'withLock returns fn() without awaiting it, so the lock is released as soon as the async callback returns a promise; the read-check-write is not serialised'),
    'seeded-migration-breaks-query': L('migrations/002_orders_total_cents.sql:2', 'high', 90, 'renaming total to total_cents breaks src/reports/revenue.js, which still runs SUM(total) on orders'),
    'seeded-fixture-hides-bug': L('src/users/dedupe.js:7', 'high', 80, 'findDuplicates compares raw emails, but emails are stored mixed-case and must go through normaliseEmail(); the fixture only has lower-case duplicates'),
    'seeded-issue-only-requirement': L('src/routes/password-reset.js:11', 'high', 90, 'returning 404 for an unknown email lets anyone enumerate which emails have accounts; the issue requires an identical response either way'),
    'seeded-quadratic-helper': L('src/reports/order-summaries.js:10', 'high', 85, 'findById is a linear list.find inside the map over every order: O(n*m), about 12 billion comparisons; keep indexById'),
    'seeded-wrong-library-api': L('src/fx/rates.js:6', 'high', 95, 'ttl-memo maxAge is in milliseconds, so maxAge: 300 caches for 0.3 s, not five minutes'),
    'seeded-large-diff': L('src/refunds/service.js:44', 'high', 85, 'approveRefund never checks refund.requested_by against the approver, so a finance user can approve their own refund; docs/refunds.md rule 6 (four-eyes) forbids it'),
  }
  for (const k of Object.keys(HIT)) HIT[k] += VERDICT
  // Correct replies from the #92 matrix that an earlier pattern missed: each grader must keep
  // passing them.
  const REAL_HIT = {
    'seeded-race-lock-helper': L('src/inventory/reserve.js:9-12', 'high', 95, 'The lock does not cover the read-check-write. `withLock` (`src/lib/lock.js:11-13`) returns `fn()`\'s pending promise and deletes the key in `finally` before the first `await` resolves.'),
    'seeded-wrong-branch-coverage': [
      L('test/coupons.test.js:3', 'high', 97, 'No test covers the new behaviour. The issue says to cover it with tests, but both tests only pass a future `expiresAt`. Deleting the new `throw` line would leave the suite green.'),
      L('test/coupons.test.js:3', 'high', 95, 'Nothing tests that an expired coupon throws. Both tests use `expiresAt: Date.now() + 60000`, so they can\'t fail.'),
      L('test/coupons.test.js:1-9', 'high', 97, 'No test covers the new rejection path. Removing the guard at `src/coupons.js:2` leaves both tests green.'),
      L('test/coupons.test.js:5-9', 'high', 95, 'The issue asks for tests covering the expiry behaviour, but both tests use `expiresAt: Date.now() + 60000`, so the throw path never runs.'),
    ].join('\n'),
  }
  for (const k of Object.keys(REAL_HIT)) REAL_HIT[k] += VERDICT
  // A reply that names the defect's words but dismisses it and approves must not score.
  const D = (loc, text, sev = 'nit') => `${L(loc, sev, 30, text, false)}\nRecommendation: merge`
  const DISMISS = {
    'seeded-sql-injection': D('src/routes/users.js:16', 'no SQL injection concern noted here, the query is concatenated but admin-only'),
    'seeded-missing-tenant-scope': D('src/invoices/repository.ts:9', 'tenant handling is not a concern in this change'),
    'seeded-auth-bypass': D('src/middleware/auth.js:6', 'health checks with no token are now allowed through; fine for the load balancer'),
    'seeded-secret-logged': D('src/auth/login.js:7', 'the log line includes the request body; no password concern since logs are internal'),
    'seeded-secret-committed': D('src/payments/client.js:5', 'the API key is hardcoded as a temporary measure, acceptable for now'),
    'seeded-off-by-one': D('src/lib/paginate.js:4', 'slice end is exclusive, pageSize - 1 looks intentional'),
    'seeded-unhandled-null': D('src/routes/users.js:15', 'findById may return null but callers pass valid ids'),
    'seeded-race-shared-state': D('src/accounts/withdraw.js:5', 'no transaction, but a race is unlikely at this volume'),
    'seeded-n-plus-one': D('src/routes/orders.js:9', 'an N+1 query in a loop, fine for small accounts'),
    'seeded-test-cannot-fail': D('test/billing.test.js:11', 'the test uses a mock; consider naming it chargeMock'),
    'seeded-wrong-branch-coverage': D('test/coupons.test.js:8', 'the expired branch has no test, a follow-up at most', 'low'),
    'seeded-unmet-requirement': D('src/routes/export.js:3', 'the date range is not applied, which can come later'),
    'seeded-invariant-violation': D('src/refunds/partial.js:6', 'the amount may be fractional, fine since the ledger stores numerics'),
    'seeded-authz-moved': D('src/routes/reports.js:14', 'the export moved to reports; admin access looks unchanged'),
    'seeded-race-lock-helper': D('src/inventory/reserve.js:9', 'withLock is not awaited but that is fine here'),
    'seeded-migration-breaks-query': D('migrations/002_orders_total_cents.sql:2', 'the revenue report may need the new column name later'),
    'seeded-fixture-hides-bug': D('src/users/dedupe.js:7', 'consider lower-casing emails some day', 'low'),
    'seeded-issue-only-requirement': D('src/routes/password-reset.js:11', 'the 404 reveals whether an account exists, acceptable for now'),
    'seeded-quadratic-helper': D('src/reports/order-summaries.js:10', 'findById is a linear scan in the loop; fine at this size', 'low'),
    'seeded-wrong-library-api': D('src/fx/rates.js:6', 'maxAge is in milliseconds; 300 might be short'),
    'seeded-large-diff': D('src/refunds/service.js:44', 'approveRefund could also check the requester; optional'),
  }
  // Seeded graders of one defect class may pass on each other's hit: that is the same defect,
  // not a different one. Every other pair must reject each other's hit.
  const SAME_CLASS = new Set(['seeded-race-shared-state<-seeded-race-lock-helper'])
  // The control's defect (RETRY_LIMIT, set only in the deployment environment) can be named only by guessing its value.
  const CONTROL_HIT = `${L('src/jobs/retry.js:5', 'high', 60, 'RETRY_LIMIT is 4096 in config, so a failing call retries for hours')}${VERDICT}`
  const MISS = `${L('src/x.js:1', 'nit', 30, 'consider renaming this variable for clarity', false)}\nRecommendation: merge`
  // Replies that block at high severity on some other defect. A grader that checks only the
  // verdict or the severity would pass these, so every seeded grader must reject all of them.
  // The first uses words the race and test graders once matched inside other words
  // (blocker, trace, mock).
  const WRONG_DEFECT = [
    `${L('src/a.js:3', 'high', 90, 'no input validation; this is a blocker')}${VERDICT}`,
    `${L('src/x.js:1', 'high', 90, 'the exported function name is misleading and has no JSDoc')}${VERDICT}`,
    `${L('src/x.js:2', 'high', 90, 'the stack trace in the error page leaks the grace period config')}${VERDICT}`,
    `${L('src/x.js:5', 'medium', 70, 'the retry runs in a loop with no backoff')}${VERDICT}`,
    `${L('test/x.test.js:4', 'medium', 70, 'use jest.mocked() for a typed mock')}\n${L('src/y.js:9', 'high', 80, 'an unbounded loop with a deeply nested callback')}${VERDICT}`,
  ]
  const FALSE_BLOCK = `${L('src/x.js:1', 'high', 70, 'this change looks risky')}${VERDICT}`
  const seeded = cases.filter((n) => n.startsWith('seeded-')), controls = cases.filter((n) => n.startsWith('control-'))
  const clean = cases.filter((n) => n.startsWith('clean-'))
  const decoys = clean.filter((n) => tagsOf(join(EV, n)).includes('decoy'))
  c(seeded.length >= 21 && clean.length >= 5 && decoys.length >= 2 && controls.length >= 1,
    `the 12 original seeded cases plus at least 10 harder ones (2 of them decoys), the clean controls and a grader control (found ${seeded.length} seeded / ${clean.length} clean, ${decoys.length} decoys / ${controls.length} control)`)
  const CATEGORIES = ['security', 'correctness', 'performance', 'tests', 'requirements']
  const catOf = (n) => tagsOf(join(EV, n)).find((t) => CATEGORIES.includes(t))
  c(seeded.every((n) => catOf(n)) && CATEGORIES.every((k) => seeded.some((n) => catOf(n) === k)),
    `every seeded case carries one category tag, and every category is covered (${seeded.map((n) => `${n}=${catOf(n)}`).join(', ')})`)
  c(seeded.every((n) => HIT[n] && DISMISS[n]), 'every seeded case has a canned hit and a canned dismissal checked below')

  // Generated files: prompts, scaffolds, dispatch graders and the full-scope copies.
  let build = null
  try { build = await import(join(ROOT, 'scripts/eval-build.mjs')) } catch (e) { c(false, `eval-build.mjs imports — ${e.message}`) }
  if (build) {
    const files = await build.generate()
    const stale = build.stale(files)
    c(stale.length === 0, `every generated eval file is up to date with the workflow (node scripts/eval-build.mjs)${stale.length ? ` — stale: ${stale.slice(0, 5).join(', ')}` : ''}`)
    const wf = readFileSync(join(ROOT, 'workflows/orchestrate.js'), 'utf8')
    // The two template literals as the workflow's source spells them, with \` unescaped.
    const literal = (name) => new RegExp(`const ${name} = \`\\n?([\\s\\S]*?)(?<!\\\\)\`\\.trim\\(\\)`).exec(wf)?.[1].replace(/\\`/g, '`').trim()
    const lightScope = literal('LIGHT_SCOPE')
    const rules = literal('RULES')
    c(lightScope?.startsWith('Review scope: LIGHT.') && rules?.startsWith('Ground rules for this dispatch:') && rules.includes('`cat .claude/delivery.md'),
      'the LIGHT scope text and the ground rules are read from workflows/orchestrate.js')
    const promptOf = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '')
    for (const n of [...cases, ...BATCH_NAMES]) {
      const scopes = BATCH_NAMES.includes(n) ? [['batch', `evals/${n}`]] : [['light', `evals/${n}`], ['full', `evals/full/${n}`]]
      for (const [scope, d] of scopes) {
        const p = promptOf(`${d}/prompt.md`)
        const y = promptOf(`${d}/case.yaml`)
        c(/subagent_type `delivery:code-review`/.test(p) && p.includes(rules) && /following the code-review procedure \(preloaded\)/.test(p)
          && (scope === 'light' ? p.includes(lightScope) : !p.includes('Review scope: LIGHT')) && /do not run `gh`/i.test(p)
          && !/```diff/.test(p) && /scaffold_script: scaffold\.sh/.test(y) && /allowed_tools: \[Agent, Read, Skill\]/.test(y),
        `${d}: dispatches delivery:code-review with the workflow's ${scope === 'light' ? 'LIGHT scope text and ' : ''}rules, on a scaffolded repository rather than a diff in the prompt`)
        const dg = existsSync(join(ROOT, d, 'graders/review-agent-dispatched.md')) ? frontmatter(readFileSync(join(ROOT, d, 'graders/review-agent-dispatched.md'), 'utf8'), d) : null
        c(dg?.type === 'tool_used' && dg.tool === 'Agent' && new RegExp(dg.input_match).test('{"subagent_type":"delivery:code-review"}')
          && !new RegExp(dg.input_match).test('{"subagent_type":"general-purpose"}') && Number(dg.min) === (n === 'per-pr-three-prs' ? 3 : 1),
        `${d}: its review-agent-dispatched grader passes only on a delivery:code-review dispatch${n === 'per-pr-three-prs' ? ' (three of them)' : ''}`)
      }
    }
    // Proof the eval follows the workflow: change the LIGHT scope text there, and the light
    // prompts change with it while the full ones do not.
    const edited = wf.replace('Review scope: LIGHT. This change was routed', 'Review scope: LIGHT. SENTINEL-SCOPE-EDIT. This change was routed')
    const moved = build.stale(await build.generate(edited))
    c(edited !== wf && moved.length === cases.length && moved.every((p) => /^evals\/[^/]+\/prompt\.md$/.test(p)),
      `an edit to LIGHT_SCOPE in workflows/orchestrate.js makes every light prompt, and only those, stale (${moved.length} of ${cases.length})`)
  }

  // Fixture repositories: each one builds, and the scaffold refuses a directory that is not empty.
  let scaf = null
  try { scaf = await import(join(ROOT, 'scripts/eval-scaffold.mjs')) } catch (e) { c(false, `eval-scaffold.mjs imports — ${e.message}`) }
  if (scaf) {
    const tmp = mkdtempSync(join(tmpdir(), 'eval-fixtures-'))
    const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout
    for (const n of [...cases, 'batch-three-prs']) {
      const d = join(tmp, n)
      mkdirSync(d)
      let err = null
      try { scaf.scaffold(readFileSync(join(EV, n, 'fixture.txt'), 'utf8'), d) } catch (e) { err = e.message }
      const prs = existsSync(join(d, '.pr')) ? readdirSync(join(d, '.pr')).filter((f) => f.endsWith('.diff')) : []
      const diffs = prs.map((f) => readFileSync(join(d, '.pr', f), 'utf8'))
      const issues = existsSync(join(d, '.pr')) ? readdirSync(join(d, '.pr')).filter((f) => /^issue-\d+\.md$/.test(f)) : []
      const clean = !err && git(d, 'status', '--porcelain').trim() === ''
      c(!err && prs.length === (n === 'batch-three-prs' ? 3 : 1) && diffs.every((t) => /^diff --git /m.test(t)) && issues.length === prs.length && clean
        && git(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim() === (n === 'batch-three-prs' ? 'main' : 'pr/1412'),
      `${n}: fixture.txt builds a repository with ${n === 'batch-three-prs' ? 'three PR branches' : 'the PR branch checked out'}, each with its diff and linked issue under .pr/ (excluded from git)${err ? ` — ${err}` : ''}`)
      if (n === 'seeded-large-diff') {
        const changed = diffs[0] ? diffs[0].split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length : 0
        c(changed >= 400, `seeded-large-diff: the pull request changes at least 400 lines (${changed})`)
      }
      if (n === 'seeded-wrong-library-api') {
        c(existsSync(join(d, 'node_modules/ttl-memo/index.js')) && !/node_modules/.test(git(d, 'ls-files')) && !/node_modules/.test(diffs[0] || ''),
          'seeded-wrong-library-api: the library is installed under node_modules but is not part of the repository or the diff')
      }
    }
    // A stand-in for a real checkout: a directory holding work. Never ROOT itself, so a broken
    // guard cannot commit this repository.
    const busy = join(tmp, 'a-checkout')
    mkdirSync(busy)
    writeFileSync(join(busy, 'work.js'), 'uncommitted work\n')
    let refused = null
    try { scaf.scaffold('@@@ head a.js\nx\n', busy) } catch (e) { refused = e.message }
    c(/refusing to build a fixture repository in a directory that is not empty/.test(refused || '') && !existsSync(join(busy, '.git')),
      'the scaffold refuses to run in a directory that is not empty, so it can never commit a real checkout as a fixture')
    rmSync(tmp, { recursive: true, force: true })
  }

  // Graders.
  for (const n of cases) {
    const re = grader(n)
    if (!n.startsWith('clean-')) c(re && !re.test(MISS), `${n}: its grader is a regex that fails on a reply that misses the defect`)
    if (n.startsWith('seeded-')) {
      c(re && WRONG_DEFECT.every((w) => !re.test(w)), `${n}: its grader fails on a high-severity do-not-merge reply that names a different defect`)
      const others = Object.keys(HIT).filter((k) => k !== n && !SAME_CLASS.has(`${n}<-${k}`) && re && re.test(HIT[k]))
      c(re && others.length === 0, `${n}: its grader fails on every other seeded case's hit${others.length ? ` — passed on ${others.join(', ')}` : ''}`)
    }
    if (HIT[n]) c(re && re.test(HIT[n]), `${n}: its grader passes on a reply that names the seeded defect`)
    if (REAL_HIT[n]) c(re && REAL_HIT[n].split('\n').filter((l) => / — /.test(l)).every((l) => re.test(`${l}${VERDICT}`)),
      `${n}: its grader passes on the correct replies from the #92 matrix that an earlier pattern missed`)
    if (DISMISS[n]) c(re && !re.test(DISMISS[n]), `${n}: its grader fails on a reply that dismisses the defect and says merge`)
    // The full-scope copy carries the same graders and tags.
    const fd = join(EV, 'full', n)
    const sameGraders = (existsSync(join(EV, n, 'graders')) ? readdirSync(join(EV, n, 'graders')) : []).filter((g) => g !== 'review-agent-dispatched.md')
      .every((g) => existsSync(join(fd, 'graders', g)) && readFileSync(join(fd, 'graders', g), 'utf8') === readFileSync(join(EV, n, 'graders', g), 'utf8'))
    c(sameGraders && existsSync(join(fd, 'case.yaml')) && new RegExp(`^name: ${n}-full$`, 'm').test(readFileSync(join(fd, 'case.yaml'), 'utf8'))
      && tagsOf(fd).includes('full-review') && JSON.stringify(tagsOf(fd).slice(1)) === JSON.stringify(tagsOf(join(EV, n)).slice(1)),
    `${n}: evals/full/${n} is the same case at FULL scope (same fixture, graders and tags; name ${n}-full)`)
  }
  const fullDirs = existsSync(join(EV, 'full')) ? readdirSync(join(EV, 'full'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []
  c(JSON.stringify(fullDirs) === JSON.stringify(cases), `every full-scope case has a light one and vice versa (${fullDirs.length} / ${cases.length})`)
  for (const n of clean) {
    const re = grader(n)
    c(re && re.test(MISS) && !re.test(FALSE_BLOCK),
      `${n}: its grader passes on a merge verdict and fails on a do-not-merge one (a false block)`)
  }
  const BAIT = {
    'clean-decoy-allowlisted-sort': L('src/routes/products.js:17', 'high', 70, 'ORDER BY ${column} is interpolated into the SQL text: SQL injection'),
    'clean-decoy-publishable-key': L('web/stripe-key.js:4', 'critical', 80, 'a live Stripe key (pk_live) is hardcoded and committed'),
  }
  for (const n of decoys) {
    const lure = graderIn(join(EV, n), 'avoids-decoy.md')
    const fm = frontmatter(readFileSync(join(EV, n, 'graders/avoids-decoy.md'), 'utf8'), n) || {}
    c(lure && fm.match === 'not_contains' && BAIT[n] && lure.test(BAIT[n]) && !lure.test(MISS),
      `${n}: a decoy, with an avoids-decoy grader that catches a high-severity finding taking the bait and passes a reply that does not`)
  }
  for (const n of controls) {
    const re = grader(n)
    c(re && Object.values(HIT).every((h) => !re.test(h)) && Object.values(DISMISS).every((h) => !re.test(h)),
      `${n}: the control grader matches no real finding, so a real reply scores 0`)
    c(re && re.test(CONTROL_HIT) && !re.test(CONTROL_HIT.replace('do not merge', 'merge')),
      `${n}: the control grader is shaped like the seeded ones (defect named plus do-not-merge verdict), so it can pass and fail`)
  }
  // The batch-review comparison: one finding grader per seeded PR, one false-block grader for the
  // clean PR, the same in both modes. A finding under the wrong PR's heading does not count.
  const bg = (n, g) => graderIn(join(EV, n), `${g}.md`)
  const SECTION = (pr, body, verdict) => `## PR #${pr}\n${body}\nRecommendation: ${verdict}`
  const B1412 = L('src/routes/notes.js:26', 'high', 95, 'DELETE matches on id alone with no user_id filter, so any user can delete another user\'s note')
  const B1413 = L('src/lib/reminders.js:3', 'high', 85, 'due_at is an ISO string (src/db.js), so comparing it with a Date is always false and no reminder is sent')
  const goodBatch = [SECTION(1412, B1412, 'do not merge'), SECTION(1413, B1413, 'do not merge'), SECTION(1415, 'None.', 'merge')].join('\n\n')
  const swapped = [SECTION(1412, B1413, 'do not merge'), SECTION(1413, B1412, 'do not merge'), SECTION(1415, 'None.', 'merge')].join('\n\n')
  const blockedClean = [SECTION(1412, 'None.', 'merge'), SECTION(1413, 'None.', 'merge'), SECTION(1415, FALSE_BLOCK.split('\n')[0], 'do not merge')].join('\n\n')
  for (const n of BATCH_NAMES) {
    const [f12, f13, nf15] = ['found-1412', 'found-1413', 'no-false-block-1415'].map((g) => bg(n, g))
    c(f12 && f13 && nf15 && f12.test(goodBatch) && f13.test(goodBatch) && nf15.test(goodBatch),
      `${n}: its three PR graders pass on a reply that finds both seeded defects and approves the clean PR`)
    c(f12 && f13 && !f12.test(swapped) && !f13.test(swapped) && WRONG_DEFECT.every((w) => !f12.test(`## PR #1412\n${w}`) && !f13.test(`## PR #1413\n${w}`)),
      `${n}: each PR grader fails when its defect is reported under another PR, or a different defect is reported under its own`)
    c(nf15 && !nf15.test(blockedClean) && f12 && !f12.test(blockedClean), `${n}: blocking the clean PR #1415 fails its no-false-block grader`)
  }
  c(['found-1412.md', 'found-1413.md', 'no-false-block-1415.md'].every((g) => readFileSync(join(EV, 'batch-three-prs/graders', g), 'utf8') === readFileSync(join(EV, 'per-pr-three-prs/graders', g), 'utf8')),
    'the batch and per-PR cases grade the same seeded defects with the same graders')
  c(/^evals\/results\/$/m.test(readFileSync(join(ROOT, '.gitignore'), 'utf8')), 'eval run results (evals/results/) are gitignored')

  // eval-run.mjs: what it would run, without running it.
  const RUN = join(ROOT, 'scripts/eval-run.mjs')
  const dry = spawnSync(process.execPath, [RUN, '--dry-run', '--out', '/x'], { encoding: 'utf8' })
  const calls = dry.stdout.split('\n').filter((l) => l.startsWith('claude plugin eval '))
  c(dry.status === 0 && calls.length === 9 && calls.every((l) => / --runs 3 /.test(l) && / --scaffold /.test(l) && / --allow-tools Bash /.test(l)
    && / --ablation none /.test(l) && / --keep-temp /.test(l) && / --trust-plugin /.test(l))
    && calls.filter((l) => / --model haiku /.test(l)).length === 3 && calls.filter((l) => / --model sonnet /.test(l)).length === 3
    && calls.filter((l) => !/ --model /.test(l)).length === 3 && ['light', 'full', 'batch'].every((s) => calls.filter((l) => l.includes(` --tag ${s}-review `)).length === 3),
  `eval-run.mjs --dry-run plans haiku, sonnet and the session model x light, full and batch at N=3, scaffolded, with Bash and traces kept (${calls.length} calls)`)
  const badRun = spawnSync(process.execPath, [RUN, '--runs', '0', '--dry-run'], { encoding: 'utf8' })
  const badTier = spawnSync(process.execPath, [RUN, '--tier', 'opus', '--dry-run'], { encoding: 'utf8' })
  c(badRun.status === 2 && badTier.status === 2 && /--tier must be one of/.test(badTier.stderr), 'eval-run.mjs refuses --runs 0 and an unknown tier')
  try {
    const { keptDirOf, harvest } = await import(RUN)
    const kd = mkdtempSync(join(tmpdir(), 'e-'))
    mkdirSync(join(kd, 'out'))
    writeFileSync(join(kd, 'out', 'trace.jsonl'), '{"type":"result","result":"x"}\n')
    const outDir = mkdtempSync(join(tmpdir(), 'eval-run-out-'))
    const jp = join(outDir, 'haiku-light.json')
    writeFileSync(jp, JSON.stringify({ schemaVersion: 1, cases: [{ name: 'seeded-x', arms: { with: [{ tracePath: join(kd, 'out', 'trace.jsonl') }] } }] }))
    const n = harvest(jp, 'haiku-light')
    const after = JSON.parse(readFileSync(jp, 'utf8')).cases[0].arms.with[0].tracePath
    c(n === 1 && after === join('traces', 'haiku-light', 'seeded-x', 'run-1.jsonl') && existsSync(join(outDir, after)) && !existsSync(kd),
      'eval-run.mjs copies each kept trace next to its result, points tracePath at the copy and deletes the kept run directory')
    c(keptDirOf(join(ROOT, 'out', 'trace.jsonl')) === null && keptDirOf('/etc/out/trace.jsonl') === null,
      'eval-run.mjs deletes only an e-* run directory under the temp directory, never anything else')
    rmSync(outDir, { recursive: true, force: true })
  } catch (e) { c(false, `eval-run.mjs harvest threw — ${e.message}`) }

  // eval-tiers.mjs: the report.
  const SCRIPT = join(ROOT, 'scripts/eval-tiers.mjs')
  const FX = join(ROOT, 'scripts/fixtures/eval-tiers')
  for (const s of ['eval-tiers.mjs', 'eval-build.mjs', 'eval-scaffold.mjs', 'eval-run.mjs']) {
    const src = readFileSync(join(ROOT, 'scripts', s), 'utf8')
    const specs = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    c(specs.length > 0 && specs.every((x) => x.startsWith('node:')), `${s} imports only node: builtins`)
  }
  c(!/\b(writeFile|appendFile|mkdir|rm|unlink|rename)(Sync)?\s*\(/.test(readFileSync(SCRIPT, 'utf8')), 'eval-tiers.mjs writes nothing')
  const t = spawnSync(process.execPath, [SCRIPT, join(FX, 'haiku.json'), join(FX, 'sonnet.json'), join(FX, 'weak.json')], { encoding: 'utf8' })
  c(t.status === 0
    && /^haiku\s+light\s+3\s+78% \[67%-100%\] of 3\s+67% \[0%-100%\] of 1\s+67% \[0%-100%\] of 1\s+100% \[100%-100%\] of 1\s+-\s+-\s+33% \[0%-100%\] of 1\s+ok \(1 scored 0\)\s+\$0\.0500 \[\$0\.0500-\$0\.0500\]\s+6\.0 \[5\.0-7\.0\]\s+0$/m.test(t.stdout)
    && /^sonnet\s+light\s+3\s+100% \[100%-100%\] of 3/m.test(t.stdout),
  `recall, per category and false blocks are a mean with the min and max pass; cost per pass; turns per run include the reviewer's, read from the trace (exit ${t.status})`)
  c(/^haiku and sonnet \(light\): recall ranges overlap, not distinguishable at N=3$/m.test(t.stdout)
    && /^sonnet and weak-tier \(light\): recall ranges do not overlap at N=3$/m.test(t.stdout),
  'two tiers whose recall ranges overlap are reported as not distinguishable at N, and two that do not, as distinguishable')
  c(/Effort was not compared: claude plugin eval has no effort flag/.test(t.stdout), 'the report says effort was not compared')
  const rr = spawnSync(process.execPath, [SCRIPT, join(FX, 'haiku.json'), join(FX, 'haiku-rerun.json')], { encoding: 'utf8' })
  c(rr.status === 0 && /^haiku\s+light\s+3\s+78% \[67%-100%\] of 3/m.test(rr.stdout) && /\s0% \[0%-0%\] of 1\s/.test(rr.stdout.split('\n')[1] || '')
    && (rr.stdout.match(/^haiku\s+light/gm) || []).length === 1 && !/false-blocked/.test(rr.stdout),
  `two files of one tier merge into one row, and a case re-run in the later file replaces its earlier runs (exit ${rr.status})`)
  const mx = spawnSync(process.execPath, [SCRIPT, join(FX, 'mixed-scopes.json')], { encoding: 'utf8' })
  c(mx.status === 0 && /^sonnet\s+full\s+3\s+0% \[0%-0%\] of 3/m.test(mx.stdout) && /^sonnet\s+light\s+3\s+100% \[100%-100%\] of 3/m.test(mx.stdout),
    `a file with both scopes gives a light and a full row (exit ${mx.status})`)
  const inv = spawnSync(process.execPath, [SCRIPT, join(FX, 'invalid-run.json')], { encoding: 'utf8' })
  c(inv.status === 1 && /1 INVALID/.test(inv.stdout) && /INVALID: sonnet light: seeded-sql-injection#2 did not dispatch the delivery:code-review agent/.test(inv.stdout)
    && /^sonnet\s+light\s+3\s+100% \[100%-100%\] of 3/m.test(inv.stdout),
  `a run that did not dispatch the review agent is flagged INVALID, left out of recall rather than counted as a miss, and exits 1 (exit ${inv.status})`)
  const b = spawnSync(process.execPath, [SCRIPT, join(FX, 'broken-control.json')], { encoding: 'utf8' })
  c(b.status === 1 && /SCORER CANNOT FAIL/.test(b.stdout), `a control case that passed in any run is flagged and exits 1 (exit ${b.status})`)
  const bt = spawnSync(process.execPath, [SCRIPT, join(FX, 'batch.json')], { encoding: 'utf8' })
  c(bt.status === 0 && /^sonnet\s+batch\s+3\s+67% \[50%-100%\] of 2\s+0\.0 \[0\.0-0\.0\]/m.test(bt.stdout) && /^sonnet\s+per-pr\s+3\s+83% \[50%-100%\] of 2\s+0\.3 \[0\.0-1\.0\]/m.test(bt.stdout)
    && /--batch-review graduation criterion \(sonnet\): MET — batch mean recall 67% >= per-PR min 50%; batch false blocks 0\.0 <= per-PR 0\.3/.test(bt.stdout),
  `the batch-review comparison reports recall per mode and the graduation criterion with its verdict (exit ${bt.status})`)
  c(/^seeded\s+2\s+1\s+0\s+1\s+1\s+0\s+1\s+1$/m.test(bt.stdout) && /^clean\s+1\s+0\s+1\s+1\s+1\s+1\s+1\s+1$/m.test(bt.stdout)
    && /of 2 found: <30: 0, <50: 1, <70: 1/.test(bt.stdout) && /highest tested threshold that loses no seeded defect is 30/.test(bt.stdout),
  'the calibration classes batch findings by the PR section they sit under, and counts a defect lost per PR')
  const cal = spawnSync(process.execPath, [SCRIPT, join(FX, 'haiku.json')], { encoding: 'utf8' })
  c(/^seeded\s+2\s+1\s+1\s+1\s+1\s+1\s+1\s+1$/m.test(cal.stdout) && /^decoy\s+1\s+1\s+0\s+0\s+0\s+0\s+0\s+1$/m.test(cal.stdout)
    && /^clean\s+1\s+0\s+1\s+1\s+1\s+1\s+1\s+1$/m.test(cal.stdout) && /^other\s+1\s+0\s+0\s+1\s+1\s+0\s+1\s+1$/m.test(cal.stdout)
    && /Seeded defects lost \(every finding naming it in that reply dropped\), of 2 found: <30: 1, <50: 1, <70: 1/.test(cal.stdout)
    && /Every threshold tested would lose at least one seeded defect/.test(cal.stdout),
  'the confidence calibration counts seeded, decoy, clean-change and other findings under 30, 50 and 70, split by what the threshold would drop, and the seeded defects a threshold would lose')
  try {
    const m = await import(SCRIPT)
    c(m.batchVerdict({ runs: 3, invalid: 0, recall: { mean: 0.4 }, falseBlocks: { mean: 0 } }, { runs: 3, invalid: 0, recall: { min: 0.5, mean: 0.8 }, falseBlocks: { mean: 0 } }).met === false
      && m.batchVerdict({ runs: 3, invalid: 0, recall: { mean: 0.9 }, falseBlocks: { mean: 1 } }, { runs: 3, invalid: 0, recall: { min: 0.5, mean: 0.8 }, falseBlocks: { mean: 0 } }).met === false
      && m.batchVerdict({ runs: 2, invalid: 0, recall: { mean: 1 }, falseBlocks: { mean: 0 } }, { runs: 3, invalid: 0, recall: { min: 0.5, mean: 0.8 }, falseBlocks: { mean: 0 } }).met === false,
    'the batch criterion fails on lower recall, on extra false blocks, and with fewer than 3 runs')
    const g = readFileSync(join(EV, 'seeded-auth-bypass/graders/found-seeded-defect.md'), 'utf8')
    const fp = new RegExp(m.findingPattern(/^pattern: '(.*)'$/m.exec(g)[1]), 'i')
    const bp = new RegExp(m.findingPattern(/^pattern: '(.*)'$/m.exec(readFileSync(join(EV, 'batch-three-prs/graders/found-1413.md'), 'utf8'))[1]), 'i')
    c(fp.test(HIT['seeded-auth-bypass'].split('\n')[0]) && !fp.test(MISS) && bp.test(B1413) && !bp.test(B1412),
      'findingPattern() reduces a found grader to its defect part, which matches one finding line')
    c(m.parseFindings(`## PR #7\n${L('a.js:1', 'High', 42, 'x', false)}\n**${L('b.js:2', 'nit', 5, 'y')}**\nnot a finding`).map((f) => `${f.pr}/${f.severity}/${f.confidence}/${f.blocking}`).join() === '7/high/42/false,7/nit/5/true',
      'parseFindings() reads severity, confidence and blocking from each finding line, and its PR from the section heading')
    const doc = JSON.parse(readFileSync(join(FX, 'haiku.json'), 'utf8'))
    c(m.summarise({ foo: 1 }, 'y') === null, 'a file that is not an eval result is rejected')
    const cats = m.loadCategories()
    c(Object.keys(cats).length === seeded.length && cats['seeded-unmet-requirement'] === 'requirements' && cats['seeded-large-diff'] === 'security',
      'the category of each seeded case is read from its case.yaml tag')
    doc.cases.find((x) => x.name === 'seeded-n-plus-one').arms.with[0].graders.find((x) => x.name === 'found-seeded-defect').passed = false
    const [r] = m.summarise(doc, 'x', cats, FX)
    c(Math.abs(r.recall.mean - 2 / 3) < 1e-9 && r.recall.min === 2 / 3 && r.recall.max === 2 / 3 && Math.abs(r.byCategory.performance.mean - 2 / 3) < 1e-9,
      `a missed seeded defect lowers recall, overall and in its category (mean ${r.recall.mean.toFixed(3)})`)
  } catch (e) { c(false, `eval-tiers.mjs import threw — ${e.message}`) }
}

// The static prompt footprint (#85): every dispatch renders, and the code-issue and
// code-review dispatches stay under their stored ceiling, so a silent re-bloat fails here.
console.log('\n== scripts/footprint.mjs ==')
{
  const c = (cond, msg) => (cond ? ok(`footprint: ${msg}`) : bad(`footprint: ${msg}`))
  const SCRIPT = join(ROOT, 'scripts/footprint.mjs')
  const src = readFileSync(SCRIPT, 'utf8')
  const specs = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
  c(specs.length > 0 && specs.every((x) => x.startsWith('node:')) && !/\b(writeFile|appendFile|mkdir|rm|unlink|rename)(Sync)?\s*\(/.test(src),
    'footprint.mjs imports only node: builtins and writes nothing')
  try {
    const { measure, overCeiling, worktreeReader, CEILINGS } = await import(SCRIPT)
    const read = worktreeReader(ROOT)
    const m = await measure(read)
    const names = ['implement', 'full review', 'light review', 'fix', 're-review', 'research', 'plan']
    c(names.every((n) => m.rows.find((r) => r.dispatch === n)?.total > 0),
      `all seven dispatches render with a measured footprint (${m.rows.map((r) => `${r.dispatch}=${r.total ?? r.missing}`).join(', ')})`)
    const over = overCeiling(m)
    c(over.length === 0 && Object.keys(CEILINGS).length === 5,
      `the code-issue and code-review dispatches are within their stored ceilings${over.length ? ` — over: ${JSON.stringify(over)}` : ''}`)
    // Proof the ceiling can fail: fold 4 KB back into the preloaded code-issue skill, and
    // name the preloaded code-review skill as a slash skill in the workflow (a second load).
    const bloated = await measure((p) => (p === 'skills/code-issue/SKILL.md' ? read(p) + 'x'.repeat(4096) : read(p)))
    const bo = overCeiling(bloated).map((o) => o.dispatch).sort()
    c(JSON.stringify(bo) === '["fix","implement"]', `4 KB added to the code-issue skill puts implement and fix over the ceiling (got ${JSON.stringify(bo)})`)
    const twice = await measure((p) => (p === 'workflows/orchestrate.js'
      ? read(p).replace('`Review pull request #', '`Follow the /delivery:code-review skill. Review pull request #') : read(p)))
    c(overCeiling(twice).some((o) => o.dispatch === 'full review'), 'a prompt that loads code-review a second time puts the full review over the ceiling')
    // The full review reads FULL_REVIEW_STEPS.md every run, so its bytes count and its growth shows.
    const row = (mm, d) => mm.rows.find((r) => r.dispatch === d)
    const refB = Buffer.byteLength(read('skills/code-review/FULL_REVIEW_STEPS.md'), 'utf8')
    c(row(m, 'full review').refBytes === refB && row(m, 're-review').refBytes === refB && !row(m, 'light review').refBytes,
      `the full review and re-review count FULL_REVIEW_STEPS.md (${refB} B) and the light review does not`)
    const grown = await measure((p) => (p === 'skills/code-review/FULL_REVIEW_STEPS.md' ? read(p) + 'x'.repeat(4096) : read(p)))
    c(JSON.stringify(overCeiling(grown).map((o) => o.dispatch).sort()) === '["full review","re-review"]',
      '4 KB added to FULL_REVIEW_STEPS.md puts the full review and re-review over the ceiling')
    const gone = await measure((p) => (p === 'workflows/orchestrate.js' ? null : read(p)))
    c(overCeiling(gone).length === 5, 'a dispatch that cannot be measured counts as over the ceiling, not as within it')
  } catch (e) { c(false, `measure() threw — ${e.message}`) }
  const run = spawnSync(process.execPath, [SCRIPT, '--ref', 'HEAD'], { encoding: 'utf8', cwd: ROOT })
  c(run.status === 0 && /^\| implement\s+\| [\d,]+ B \/ ~[\d,]+ tok/m.test(run.stdout) && /blocking cycle/.test(run.stdout),
    `--ref HEAD prints a per-dispatch table with the cycle sums (exit ${run.status})`)
  const opt = spawnSync(process.execPath, [SCRIPT, '--ref', '--output=/dev/null'], { encoding: 'utf8', cwd: ROOT })
  c(opt.status === 2 && /not a git ref/.test(opt.stderr), `a --ref that starts with "-" is refused, never passed to git (exit ${opt.status})`)
}

// The pipeline-replay benchmark (#86): opt-in and never wired into CI. bench-report.mjs is
// checked against a synthetic results tree in which one ref shows every behaviour the 0.8.0
// fixes removed and the other none; bench-run.mjs only in --dry-run, which executes nothing.
console.log('\n== bench/ and scripts/bench-*.mjs ==')
{
  const c = (cond, msg) => (cond ? ok(`bench: ${msg}`) : bad(`bench: ${msg}`))
  const RUN = join(ROOT, 'scripts/bench-run.mjs'), REP = join(ROOT, 'scripts/bench-report.mjs')
  for (const f of [RUN, REP]) {
    const src = readFileSync(f, 'utf8')
    const specs = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    c(specs.length > 0 && specs.every((x) => x.startsWith('node:')), `${basename(f)} imports only node: builtins`)
  }
  c(!/\b(writeFile|appendFile|mkdir|rm|unlink|rename|cpSync|spawn|exec)\w*\s*\(/.test(readFileSync(REP, 'utf8')), 'bench-report.mjs writes nothing and runs nothing')
  const ci = readdirSync(join(ROOT, '.github/workflows')).map((f) => readFileSync(join(ROOT, '.github/workflows', f), 'utf8')).join('\n')
  c(!/bench-(run|report)/.test(ci), 'the benchmark is not wired into CI')
  c(/^bench\/results\/$/m.test(readFileSync(join(ROOT, '.gitignore'), 'utf8')), 'bench results (bench/results/) are gitignored')
  const doc = readFileSync(join(ROOT, 'docs/benchmarks.md'), 'utf8')
  c(/million tokens/.test(doc.split('\n').slice(0, 12).join('\n')) && /bench-run\.mjs/.test(doc) && /--reset-scratch/.test(doc),
    'docs/benchmarks.md states the cost of a full run at the top and how to run it')
  c(/\*\*caller\*\*: 3 points/.test(doc) && /trap rate is measured only by a paid replay, never by CI/.test(doc) && /\*\*planted defect\*\*/.test(doc),
    'docs/benchmarks.md explains the caller scenario, the planted-defect column, and that its trap rate is measured by a paid replay, not CI')

  // The fixture project and the canned issues.
  const FX = join(ROOT, 'bench/fixture-repo')
  const pkg = JSON.parse(readFileSync(join(FX, 'package.json'), 'utf8'))
  const t = spawnSync(process.execPath, ['--test'], { cwd: FX, encoding: 'utf8' })
  c(pkg.scripts?.test === 'node --test' && t.status === 0 && existsSync(join(FX, '.github/workflows/ci.yml')) && existsSync(join(FX, 'CLAUDE.md')),
    `the fixture repo has a CLAUDE.md, a CI-shaped npm test, and its suite passes (exit ${t.status})`)
  try {
    const run = await import(RUN)
    const issues = Object.fromEntries(run.ISSUES.map((i) => [i.name, run.parseIssue(readFileSync(join(ROOT, 'bench/issues', `${i.name}.md`), 'utf8'))]))
    c(run.ISSUES.every((i) => issues[i.name].points === i.points && new RegExp(`^\\*\\*Story Points\\*\\*: ${i.points}$`, 'm').test(issues[i.name].body)),
      'each canned issue\'s Story Points line matches the --points hint it is run with (small 1, medium 3, trap 3, caller 3)')
    c(Object.values(issues).every((i) => i.labels.length && !i.labels.some((l) => /secur|auth|migrat|breaking|payment|billing|privacy|infra|data-loss/i.test(l))),
      'no canned issue carries a risk label, so the small one is eligible for the light review')
    // #94: in the Notes alone the reviewer did not catch it, so the requirement is now in an
    // acceptance criterion, as a clause of the bullet whose obvious implementation breaks it.
    const trapAc = issues.trap.body.split('## Acceptance criteria')[1]?.split('\n## ')[0] || ''
    c(/subtracts `qty`[^\n]*\n\s+[^\n]*key is deleted, not left at 0/.test(trapAc),
      'the trap issue states its planted requirement (an emptied SKU\'s key is deleted) inside the acceptance criteria, in the subtract bullet')
    // #98: a scenario whose planted defect is in an unchanged caller, to drive review -> fix.
    // Its matcher lives in front matter, which is never filed, so no agent sees it.
    const cp = issues.caller?.planted
    c(issues.caller?.points === 3 && cp && /never filed/.test(cp.note)
      && JSON.stringify(cp.locations) === '["src/reorder.js"]' && JSON.stringify(cp.keywords) === '["reorderLines","reorder.js"]'
      && issues.small.planted === null && issues.trap.planted === null,
    `the caller scenario carries its planted defect (note, locations, keywords) in front matter; issues without one have none (got ${JSON.stringify(cp)})`)
    const fxText = readdirSync(FX, { recursive: true }).filter((f) => statSync(join(FX, f)).isFile()).map((f) => readFileSync(join(FX, f), 'utf8')).join('\n')
    c(!/reorder|defect|planted|object Object|NaN/i.test(issues.caller.title + issues.caller.body) && !/defect|planted|object Object|NaN/i.test(fxText),
      'the planted defect is described nowhere the agents look: not in the filed title or body, nor in the fixture repository')
    // The trap is real: the natural implementation keeps the fixture suite green and breaks the
    // unchanged caller. Applied to a copy, never to the committed fixture.
    const tmpF = mkdtempSync(join(tmpdir(), 'bench-caller-'))
    try {
      cpSync(FX, tmpF, { recursive: true })
      const inv = join(tmpF, 'src/inventory.js'), invT = join(tmpF, 'test/inventory.test.js')
      const src0 = readFileSync(inv, 'utf8'), test0 = readFileSync(invT, 'utf8')
      const src1 = src0.replace('.filter((sku) => stock[sku] < threshold).sort()', '.filter((sku) => stock[sku] < threshold).sort().map((sku) => ({ sku, qty: stock[sku] }))')
      const test1 = test0.replace("['a', 'c']", "[{ sku: 'a', qty: 0 }, { sku: 'c', qty: 1 }]")
      writeFileSync(inv, src1); writeFileSync(invT, test1)
      const suite = spawnSync(process.execPath, ['--test'], { cwd: tmpF, encoding: 'utf8' })
      const before = (await import(pathToFileURL(join(FX, 'src/reorder.js')).href)).reorderLines({ a: 0, b: 9 }, 2)
      const after = (await import(pathToFileURL(join(tmpF, 'src/reorder.js')).href)).reorderLines({ a: 0, b: 9 }, 2)
      c(src1 !== src0 && test1 !== test0 && suite.status === 0 && JSON.stringify(before) === '["a,2"]' && JSON.stringify(after) === '["[object Object],NaN"]',
        `the caller scenario's natural implementation passes the fixture suite and breaks the unchanged reorderLines (suite exit ${suite.status}, before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`)
    } finally { rmSync(tmpF, { recursive: true, force: true }) }
    c(existsSync(join(ROOT, 'bench/topics/plan-epic.md')), 'the plan-epic topic file is committed')
    c(run.parseIssue(readFileSync(join(ROOT, 'bench/issues/small.md'), 'utf8').replace(/\n/g, '\r\n')).title === issues.small.title, 'an issue file with CRLF line endings parses')
    const tmpR = mkdtempSync(join(tmpdir(), 'bench-stale-'))
    const steps = run.plan(run.parseArgs(['--ref', 'HEAD', '--repo', 'a/b', '--dry-run', '--runs', '2', '--out', tmpR]))
    mkdirSync(join(steps[0].out, 'sessions', 'old-session'), { recursive: true })
    mkdirSync(join(tmpR, 'HEAD', 'orchestrate', 'run-9'), { recursive: true })
    run.clearResults(steps)
    c(!existsSync(join(tmpR, 'HEAD', 'orchestrate')) && !existsSync(join(tmpR, 'HEAD', 'orchestrate', 'run-9')), 'a rerun clears the ref and scenario results first, so a stale session or run-N is not read again')
    rmSync(tmpR, { recursive: true, force: true })
    let collide = ''
    try { run.parseArgs(['--ref', 'HEAD~1', '--ref', 'HEAD^1', '--repo', 'a/b', '--dry-run']) } catch (e) { collide = e.message }
    c(/same results directory/.test(collide), 'two refs that map to one results directory are refused')
    // Per-ref isolation (#94). One --repo is shared by every ref; one per ref gives each its own.
    const shared = run.parseArgs(['--ref', 'A', '--ref', 'B', '--repo', 'o/s', '--dry-run'])
    const perRef = run.parseArgs(['--ref', 'A', '--ref', 'B', '--repo', 'o/a', '--repo', 'o/b', '--dry-run'])
    c(shared.isolation === 'reset' && run.plan(shared).every((st) => st.repo === 'o/s')
      && perRef.isolation === 'repo-per-ref' && run.plan(perRef).every((st) => st.repo === (st.ref === 'A' ? 'o/a' : 'o/b')),
    'one --repo is shared by every ref (isolation "reset"); one per --ref gives each ref its own (isolation "repo-per-ref")')
    const bad = (...a) => { try { run.parseArgs(a); return '' } catch (e) { return e.message } }
    c(/one different --repo per --ref/.test(bad('--ref', 'A', '--ref', 'B', '--ref', 'C', '--repo', 'o/a', '--repo', 'o/b', '--dry-run'))
      && /one different --repo per --ref/.test(bad('--ref', 'A', '--ref', 'B', '--repo', 'o/a', '--repo', 'o/a', '--dry-run')),
    'a --repo count that is neither 1 nor one per ref, or two refs given the same repo, is refused')
    // A fake GitHub: the first ref files its issues and an epic, opens a PR on a branch and
    // closes one issue; after the reset the second ref's own queries, including the planner's
    // `--state all` duplicate search, must find nothing the first one left.
    const fakeGitHub = () => {
      const st = { issues: new Map(), prs: new Map(), branches: new Set(['main']), next: 1 }
      const gh = (a) => {
        const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d)
        const pick = (m, state) => JSON.stringify([...m].filter(([, x]) => state === 'all' || x.state === state).map(([number, x]) => ({ number, title: x.title })))
        const [cmd, sub] = a
        if (cmd === 'issue' && sub === 'create') { const n = st.next++; st.issues.set(n, { title: opt('--title'), state: 'open' }); return `https://github.com/o/s/issues/${n}` }
        if (cmd === 'issue' && sub === 'list') return pick(st.issues, opt('--state', 'open'))
        if (cmd === 'issue' && sub === 'close') { st.issues.get(Number(a[2])).state = 'closed'; return '' }
        if (cmd === 'issue' && sub === 'delete') { st.issues.delete(Number(a[2])); return '' }
        if (cmd === 'pr' && sub === 'create') { const n = st.next++; st.prs.set(n, { title: opt('--title'), state: 'open' }); st.branches.add(opt('--head')); return '' }
        if (cmd === 'pr' && sub === 'list') return pick(st.prs, opt('--state', 'open'))
        if (cmd === 'pr' && sub === 'close') { st.prs.get(Number(a[2])).state = 'closed'; return '' }
        if (cmd === 'repo' && sub === 'view') return 'main\n'
        if (cmd === 'api' && sub === '-X' && a[2] === 'DELETE') { st.branches.delete(decodeURIComponent(a[3].split('/git/refs/heads/')[1])); return '' }
        if (cmd === 'api') return [...st.branches].join('\n') + '\n'
        throw new Error(`fake gh: unexpected ${a.join(' ')}`)
      }
      return { st, gh }
    }
    const { st, gh } = fakeGitHub()
    for (const t of ['Add removeItem', 'Add restock', 'Epic: audit log']) gh(['issue', 'create', '--repo', 'o/s', '--title', t])
    gh(['issue', 'close', '1', '--repo', 'o/s'])
    gh(['pr', 'create', '--repo', 'o/s', '--title', 'feat: removeItem', '--head', 'feature/issue-1-remove-item'])
    const reset = run.resetScratch('o/s', gh)
    const seen = [['issue', 'list', '--repo', 'o/s', '--state', 'all', '--search', 'audit log', '--json', 'number'], ['issue', 'list', '--repo', 'o/s', '--json', 'number'],
      ['pr', 'list', '--repo', 'o/s', '--state', 'all', '--json', 'number']].map((q) => JSON.parse(gh(q)).length)
    c(JSON.stringify(reset) === '{"issuesDeleted":3,"prsClosed":1,"branchesDeleted":1}' && seen[0] === 0 && seen[1] === 0
      && [...st.prs.values()].every((x) => x.state === 'closed') && JSON.stringify([...st.branches]) === '["main"]',
    `after the reset the second ref sees no issue the first filed, open or closed, no open PR and no branch but main (${JSON.stringify({ reset, seen, branches: [...st.branches] })})`)
    const noAdmin = fakeGitHub()
    noAdmin.gh(['issue', 'create', '--repo', 'o/s', '--title', 'x'])
    let denied = ''
    try { run.resetScratch('o/s', (a) => { if (a[1] === 'delete') throw new Error('HTTP 403'); return noAdmin.gh(a) }) } catch (e) { denied = e.message }
    let leftover = ''
    try { run.resetScratch('o/s', (a) => (a[1] === 'delete' ? '' : noAdmin.gh(a))) } catch (e) { leftover = e.message }
    c(/admin rights/.test(denied) && /still has 1 issue/.test(leftover), 'a reset that cannot delete an issue, or leaves one behind, stops the run instead of starting it on a dirty repo')
    // runStep needs GitHub and claude, so it is not run here; this holds it to resetting the
    // step's repository before it pushes the fixture or files an issue, and recording the result.
    const stepSrc = readFileSync(RUN, 'utf8').split('function runStep')[1] || ''
    const at = (re) => stepSrc.search(re)
    c(at(/resetScratch\(repo,/) > 0 && at(/resetScratch\(repo,/) < at(/'push'/) && at(/resetScratch\(repo,/) < at(/'issue', 'create'/) && /isolation, calls/.test(stepSrc),
      'each step resets its scratch repository before it pushes or files anything, and records the isolation in meta.json')
    // #98: the plugin under test is exported from this repository, which holds the planted
    // defects and their descriptions; the export must carry none of them, nor git history.
    c(at(/exportPlugin\(sha, pluginDir\)/) > 0 && at(/exportPlugin\(sha, pluginDir\)/) < at(/spawnSync\('claude'/)
      && /planted: c\.planted \?\? null/.test(stepSrc),
    'each step exports the plugin before any claude call, and records each call\'s planted defect in meta.json')
    const exp = mkdtempSync(join(tmpdir(), 'bench-export-'))
    try {
      run.exportPlugin('HEAD', exp)
      const leaks = []
      const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else if (/reorderLines|reorder\.js|planted defect/i.test(readFileSync(f, 'latin1'))) leaks.push(f.slice(exp.length + 1)) } }
      walk(exp)
      c(existsSync(join(exp, '.claude-plugin', 'plugin.json')) && !existsSync(join(exp, '.git')) && !existsSync(join(exp, 'bench')) && leaks.length === 0,
        `the exported plugin has its manifest, no .git and no file naming a planted defect (leaks: ${JSON.stringify(leaks)})`)
    } finally { rmSync(exp, { recursive: true, force: true }) }
    // --orchestrate-args (#96): extra flags on every orchestrate call, with results kept apart
    // from the same ref's plain run, so one ref can be replayed under two settings.
    const plain = run.plan(run.parseArgs(['--ref', 'HEAD', '--repo', 'o/s', '--dry-run', '--out', '/r']))
    const eff = run.plan(run.parseArgs(['--ref', 'HEAD', '--repo', 'o/s', '--dry-run', '--out', '/r', '--orchestrate-args', '--small-effort medium']))
    const orch = (ps) => ps.find((st) => st.scenario === 'orchestrate'), epicStep = (ps) => ps.find((st) => st.scenario === 'plan-epic')
    c(orch(eff).calls.every((k) => k.prompt.endsWith(' --small-effort medium') && /^\/delivery:orchestrate <#\w+> --points \d --small-effort medium$/.test(k.prompt))
      && orch(plain).calls.every((k) => !/small-effort/.test(k.prompt))
      && epicStep(eff).calls[0].prompt === '/delivery:plan-epic ./PLAN-TOPIC.md',
    '--orchestrate-args is appended to every orchestrate call and to no plan-epic call')
    c(orch(eff).out !== orch(plain).out && dirname(orch(eff).out) !== dirname(orch(plain).out)
      && orch(eff).orchestrateArgs === '--small-effort medium' && orch(plain).orchestrateArgs === null,
    `a run with --orchestrate-args writes to its own results directory, so it neither clears nor mixes with the plain run (${orch(eff).out})`)
    for (const v of ['412', '--points 1; rm -rf /', '--small-effort $(id)', '', '--small-effort "medium"']) {
      c(/--orchestrate-args/.test(bad('--ref', 'HEAD', '--repo', 'o/s', '--dry-run', '--orchestrate-args', v)),
        `--orchestrate-args ${JSON.stringify(v)} is refused: it must be flags, in letters, digits, = . _ - and spaces`)
    }
    const args = run.claudeArgs('/delivery:orchestrate 3 --points 1', '/tmp/p')
    c(JSON.stringify(args) === JSON.stringify(['-p', '/delivery:orchestrate 3 --points 1', '--plugin-dir', '/tmp/p', '--output-format', 'json', '--dangerously-skip-permissions']),
      'each pipeline call is claude -p with --plugin-dir pointed at the ref\'s worktree, prompt first')
  } catch (e) { c(false, `bench-run.mjs import threw — ${e.message}`) }
  // `no.such.owner` cannot be a GitHub account (logins have no dots), and git may not prompt:
  // if a guard below ever broke, the run it let through would fail at its first push.
  const cli = (...a) => spawnSync(process.execPath, [RUN, ...a], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  const before = existsSync(join(ROOT, 'bench/results'))
  const dry = cli('--ref', '6567d82', '--ref', 'HEAD', '--repo', 'no.such.owner/scratch', '--dry-run')
  const lines = dry.stdout.split('\n').filter((l) => /^\s+claude -p /.test(l))
  c(dry.status === 0 && /DRY RUN — nothing will be executed/.test(dry.stdout) && lines.length === 10
    && lines.filter((l) => /\/delivery:orchestrate <#small> --points 1"/.test(l)).length === 2
    && lines.filter((l) => /\/delivery:orchestrate <#caller> --points 3"/.test(l)).length === 2
    && lines.filter((l) => /\/delivery:plan-epic/.test(l)).length === 2 && lines.every((l) => /--plugin-dir/.test(l))
    && existsSync(join(ROOT, 'bench/results')) === before && /Isolation: reset \(one scratch repo, no\.such\.owner\/scratch, shared by every ref, reset before every step\)/.test(dry.stdout)
    && (dry.stdout.match(/\[reset no\.such\.owner\/scratch first\]/g) || []).length === 4,
  `--dry-run prints 10 calls for two refs (4 orchestrate + 1 plan-epic each) and runs nothing, naming the isolation and the reset before each of the 4 steps (exit ${dry.status})`)
  c(cli('--ref', 'HEAD', '--dry-run').status === 2, 'without --repo it refuses to start')
  const noAck = cli('--ref', 'HEAD', '--repo', 'no.such.owner/scratch')
  c(noAck.status === 2 && /--reset-scratch is required/.test(noAck.stderr), 'a real run without --reset-scratch refuses to start')
  c(cli('--ref', '--output=/dev/null', '--repo', 'a/b', '--dry-run').status === 2, 'a --ref starting with "-" is refused')

  // bench-report on the synthetic tree.
  try {
    const rep = await import(REP)
    const groups = rep.aggregate(rep.collect(join(ROOT, 'scripts/fixtures/bench')))
    const g = (ref, sc) => groups.find((x) => x.ref === ref && x.scenario === sc)
    const old = g('old', 'orchestrate'), neu = g('new', 'orchestrate'), epic = g('new', 'plan-epic')
    c(old && Object.values(old.checks).every((v) => v === false), `every behaviour check fails on the ref that shows each behaviour (${JSON.stringify(old?.checks)})`)
    c(neu && Object.values(neu.checks).every((v) => v === true), `every behaviour check passes on the ref that shows none (${JSON.stringify(neu?.checks)})`)
    c(epic && epic.checks.fullReviewHigh === null && epic.checks.fixNoNewBranchOrPr === null && epic.epicFiled === true,
      'plan-epic has no review or fix to check, and records whether the epic was filed')
    c(neu.runs === 2 && neu.tokens === 12265 && neu.wallMs === 45000 && neu.costUsd === 1.5 && neu.fixCycles === 1
      && JSON.stringify(neu.findings) === '{"critical":0,"high":1.5,"medium":0,"low":0,"nit":1}'
      && JSON.stringify(neu.outputByPhase) === '{"Implement":400,"Review":185,"Fix":20,"Re-review":5}',
    `numbers are means over runs: tokens, wall time, cost, findings by severity, output per phase (got ${JSON.stringify({ t: neu.tokens, w: neu.wallMs, c: neu.costUsd, f: neu.findings })})`)
    c(neu.costUsd === 1.5, 'cost is summed over every claude call of a run (1 + 2 split over two calls)')
    // An epic counts as filed only if the scratch repo gained issues: a planner that replied
    // but filed nothing (or asked a question) must read as not filed.
    const stalled = g('stalled', 'plan-epic')
    c(stalled && stalled.epicFiled === false && /^stalled\s+plan-epic\s.*\sNO\s+none$/m.test(rep.render(groups)) && epic.epicFiled === true,
      'a plan-epic whose planner replied but filed no issue reads as epic NOT filed')
    const crashed = g('crashed', 'orchestrate')
    c(crashed && crashed.incompleteRuns === 1 && neu.incompleteRuns === 0 && old.incompleteRuns === 0 && /WARNING: crashed \/ orchestrate: 1 of 1 run\(s\) INCOMPLETE/.test(rep.render(groups)),
      'a run with a non-zero exit or a missing session is flagged incomplete, and complete runs are not')
    const runs = rep.collect(join(ROOT, 'scripts/fixtures/bench'))
    const mixed = rep.aggregate([runs.find((x) => x.ref === 'old'), ...runs.filter((x) => x.ref === 'new' && x.scenario === 'orchestrate')].map((x) => ({ ...x, ref: 'm' })))
    c(mixed.length === 1 && mixed[0].runs === 3 && Object.values(mixed[0].checks).every((v) => v === false),
      'a check that failed in any one run fails for the ref, however many runs passed')
    c(neu.maxTurns['delivery:code-review'] === 4 && old.maxTurns['delivery:code-issue'] === 3, 'the highest turn count per agent type is reported')
    const out = rep.render(groups)
    c(/^old\s+orchestrate\s+FAIL\s+FAIL\s+FAIL\s+FAIL$/m.test(out) && /^new\s+plan-epic\s+n\/a\s+n\/a\s+PASS\s+PASS$/m.test(out)
      && /^new\s+orchestrate\s+2\s+12,265\s+Implement 400, Review 185, Fix 20, Re-review 5\s+0\.8 min\s+\$1\.50\s+0\/1\.5\/0\/0\/1\s+1\s+-\s+reset$/m.test(out),
    'the report prints the comparison table and the behaviour checks')
    // Token types per phase (#94): new/orchestrate run 1 and 2 are identical, 4 messages of
    // 10 input, 100 cache write, 1,000 cache read and 100 output in its implementer.
    c(JSON.stringify(neu.tokensByPhase.Implement) === '{"input":40,"cacheWrite":400,"cacheRead":4000,"output":400}'
      && Object.values(neu.tokensByPhase).reduce((n, t) => n + t.input + t.cacheWrite + t.cacheRead + t.output, 0) === neu.tokens
      && Object.entries(neu.tokensByPhase).every(([p, t]) => t.output === neu.outputByPhase[p]),
    `tokens are split by type per phase and add up to the total (got ${JSON.stringify(neu.tokensByPhase)})`)
    c(/^new\s+orchestrate\s+Implement\s+40\s+400\s+4,000\s+400$/m.test(out) && /^new\s+orchestrate\s+all\s+105\s+1,050\s+10,500\s+610$/m.test(out)
      && /^new\s+plan-epic\s+Plan\s+20\s+200\s+2,000\s+400$/m.test(out),
    'the report prints input, cache write, cache read and output per ref, scenario and phase, with an all-phases row')
    const fixWarn = /WARNING: (\S+) \/ orchestrate: no run exercised the Fix phase/g
    c(JSON.stringify([...out.matchAll(fixWarn)].map((m) => m[1])) === '["crashed"]' && crashed.fixRan === false && neu.fixRan === true,
      'the report warns for each orchestrate ref in which no run reached the Fix phase, and only for those')
    // #98: review outcome per scenario issue. new/orchestrate: #8 is the caller scenario; run 1's
    // review blocks on a finding at src/reorder.js (a hit), run 2's blocks on an unrelated one and
    // names reorder.js only in a non-blocking finding (a miss). #9 (small) never blocks and has
    // no planted defect. old/orchestrate's #7 predates `review` and the call numbers: it blocked
    // (a fix ran), and whether the planted defect was found is unknown.
    const oc = (grp, issue) => grp?.reviewOutcomes?.find((x) => x.issue === issue)
    c(JSON.stringify(oc(neu, 'caller')) === '{"issue":"caller","runs":2,"reviewed":2,"blocking":2,"planted":true,"plantedKnown":2,"plantedHits":1}'
      && JSON.stringify(oc(neu, 'small')) === '{"issue":"small","runs":2,"reviewed":2,"blocking":0,"planted":false,"plantedKnown":0,"plantedHits":0}'
      && JSON.stringify(oc(old, '#7')) === '{"issue":"#7","runs":1,"reviewed":1,"blocking":1,"planted":false,"plantedKnown":0,"plantedHits":0}'
      && epic.reviewOutcomes.length === 0,
    `per ref and scenario issue: runs whose first review blocked, and runs whose blocking findings named the planted defect (got ${JSON.stringify([neu?.reviewOutcomes, old?.reviewOutcomes])})`)
    c(/^new\s+orchestrate\s+caller\s+2\s+2\/2 \(100%\)\s+1\/2 \(50%\)$/m.test(out) && /^new\s+orchestrate\s+small\s+2\s+0\/2 \(0%\)\s+-$/m.test(out)
      && /^old\s+orchestrate\s+#7\s+1\s+1\/1 \(100%\)\s+-$/m.test(out) && !/^new\s+plan-epic\s+\S+\s+\d+\s+\d+\/\d+ \(/m.test(out),
    'the report prints the blocking-finding rate and the planted-defect hit rate per ref and scenario issue')
    const P = { locations: ['src/reorder.js:5-7', 'lib/x.js'], keywords: ['reorderLines'] }
    const F = (location, summary = 'something else') => ({ location, summary, blocking: true })
    c(rep.matchesPlanted(F('src/reorder.js:6'), P) && rep.matchesPlanted(F('./src/reorder.js:7'), P) && rep.matchesPlanted(F('reorder.js:5-9'), P)
      && rep.matchesPlanted(F('pkg/lib/x.js:400'), P) && rep.matchesPlanted(F('src/inventory.js:14', 'breaks REORDERLINES'), P)
      && !rep.matchesPlanted(F('src/reorder.js:9'), P) && !rep.matchesPlanted(F('src/reorder.js'), P) && !rep.matchesPlanted(F('src/notreorder.js:6'), P)
      && !rep.matchesPlanted(F('general'), P) && !rep.matchesPlanted(F('src/inventory.js:14'), P) && !rep.matchesPlanted(F('x'), { locations: [], keywords: [''] }),
    'the planted-defect matcher takes a file (and a line range when given) or a keyword, case-insensitively, and nothing else')
    // #96: the implement effort each batch recorded, and the orchestrate args a run was given.
    c(neu.implementEffort === 'high, medium' && old.implementEffort === null
      && /^new\s+orchestrate\s+high, medium$/m.test(out) && /^old\s+orchestrate\s+n\/a$/m.test(out),
    `the report shows the implement effort the orchestrate results recorded (got new=${neu.implementEffort}, old=${old.implementEffort})`)
    const tmpA = mkdtempSync(join(tmpdir(), 'bench-args-'))
    const runA = join(tmpA, 'new+--small-effort_medium', 'orchestrate', 'run-1')
    mkdirSync(runA, { recursive: true })
    writeFileSync(join(runA, 'meta.json'), JSON.stringify({ ref: 'new', scenario: 'orchestrate', orchestrateArgs: '--small-effort medium', calls: [] }))
    const argsRun = rep.analyseRun(runA)
    rmSync(tmpA, { recursive: true, force: true })
    c(argsRun.ref === 'new [--small-effort medium]' && argsRun.orchestrateArgs === '--small-effort medium'
      && rep.analyseRun(join(ROOT, 'scripts/fixtures/bench/new/orchestrate/run-1')).ref === 'new',
    `a run given --orchestrate-args is labelled with them, so it is reported apart from the plain run of its ref (got ${argsRun.ref})`)
    c(epic.isolation === 'repo-per-ref' && crashed.isolation === 'none' && /^new\s+plan-epic\s.*\syes\s+repo-per-ref$/m.test(out)
      && /WARNING: stalled \/ plan-epic: no scratch-repo isolation recorded/.test(out) && !/WARNING: new \/ orchestrate: no scratch-repo isolation/.test(out),
    'the report names the isolation each ref ran with, and warns on results that recorded none')
    // Each detector, against what it must and must not match.
    const B = (command) => ({ name: 'Bash', input: { command } })
    c(['git checkout -b x', 'git switch -c x', 'git branch topic', 'gh pr create --fill', 'cd w && git checkout -B y'].every((x) => rep.createsBranchOrPr(B(x)))
      && !['gh pr checkout 5 --detach', 'git push origin HEAD:feature/x', 'git checkout --detach', 'git branch -D old', 'git branch --show-current'].some((x) => rep.createsBranchOrPr(B(x))),
    'the new-branch-or-PR detector matches creation and not checkout, push or deletion')
    c(!rep.readsClaudeMd(B('gh pr comment 1 --body "head: 74 tests.\n- CLAUDE.md sets"')) && !rep.readsClaudeMd(B('gh pr comment 1 --body "the agents cat CLAUDE.md again"'))
      && rep.readsClaudeMd(B('cd w && head -20 CLAUDE.md')) && rep.readsClaudeMd(B('ls | cat CLAUDE.md')) && !rep.readsClaudeMd({ name: 'Glob', input: { pattern: '**/CLAUDE.md' } }),
    'the CLAUDE.md-read detector is anchored to a command: prose that names it, and a Glob, do not count')
    c(!rep.createsBranchOrPr(B('git worktree add $W x && git log -b')) && rep.createsBranchOrPr(B('git worktree add $W abc123 -b scratch')),
      'the worktree-add alternative of the new-branch detector does not span past && into a later command')
    c(rep.readsClaudeMd({ name: 'Read', input: { file_path: '/w/CLAUDE.md' } }) && rep.readsClaudeMd(B('cat CLAUDE.md'))
      && !rep.readsClaudeMd({ name: 'Read', input: { file_path: '/w/docs/templates/CLAUDE.md.bak' } }) && !rep.readsClaudeMd(B('git add CLAUDE.md')),
    'the CLAUDE.md-read detector matches a Read or a cat of it and not other commands that name it')
    const tr = rep.readTranscript([
      JSON.stringify({ type: 'assistant', effort: 'high', message: { id: 'm1', content: [{ type: 'text' }] } }),
      JSON.stringify({ type: 'assistant', effort: 'high', message: { id: 'm1', usage: { input_tokens: 1, output_tokens: 7 }, content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: 'x' } }), 'not json',
    ].join('\n'))
    c(tr.turns === 1 && tr.tokens.output === 7 && tr.tools.length === 1 && JSON.stringify(tr.efforts) === '["high"]',
      'streamed blocks of one message count as one turn, and its usage once')
  } catch (e) { c(false, `bench-report.mjs threw — ${e.message}`) }
}

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
