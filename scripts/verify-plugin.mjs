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
//
// It exists because every one of those failures is silent at runtime.
import { readFileSync, readdirSync, existsSync, statSync, rmSync, mkdirSync, symlinkSync, copyFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, basename, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    if (!line.trim()) continue
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
  checkSkill(/single response/i.test(orient) && /in full/i.test(orient), 'code-review Orient reads every changed file in full, in parallel in a single response')
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
  // Step 7 embeds a markdown template with its own ### headings, so bound it by Step 8.
  // Both headings must exist: indexOf -1 would make the slice cover most of the file.
  const g7 = gather.indexOf('### Step 7: Compile'), g8 = gather.indexOf('### Step 8')
  checkSkill(g7 > 0 && g8 > g7, 'research-gather has its Step 7 and Step 8 headings, in order, to bound Step 7')
  checkSkill(g7 > 0 && g8 > g7 && DISPATCH_SKIP.test(gather.slice(g7, g8)),
    'research-gather Step 7 skips the user question when dispatched')

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
    for (const f of ['agents/code-planner.md', 'agents/research.md', 'agents/code-review.md', 'agents/code-issue.md']) {
      checkSkill(/has neither/.test(readFileSync(join(ROOT, f), 'utf8')), `${f} says what to do when the repository has neither CLAUDE.md nor AGENTS.md`)
    }
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
        dispatches.length === 2 && dispatches.every((d) => squash(d.prompt).includes(UNATTENDED) && /If it has neither/.test(d.prompt))
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

  check(r.dispatches.every((d) => /If it has neither/.test(d.prompt)),
    'every dispatch says what to do when the repository has neither CLAUDE.md nor AGENTS.md')

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

console.log(`\n${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`)
process.exit(fails === 0 ? 0 : 1)
