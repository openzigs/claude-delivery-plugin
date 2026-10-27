#!/usr/bin/env node
//
// Build one review eval case's fixture repository in the current directory. Stdlib only.
//
//   node scripts/eval-scaffold.mjs evals/<case>/fixture.txt
//
// `claude plugin eval --scaffold` runs each case's generated scaffold.sh in an empty workspace,
// and that script runs this. It turns the case's fixture.txt into a git repository that stands in
// for a GitHub pull request, so the reviewer reads real files rather than a diff in its prompt:
//
//   main            the base: every `base` file, committed
//   pr/<n>          one branch per pull request: its `head` files written, its `delete` files
//                   removed, committed on top of main
//   .pr/<n>.diff    `git diff main...pr/<n>`, standing in for `gh pr diff <n>`
//   .pr/<n>-body.md the PR body, standing in for `gh pr view <n> --json body`
//   .pr/issue-<i>.md the linked issue, standing in for `gh issue view <i>`
//
// .pr/ is excluded through .git/info/exclude, so it is never part of a diff. With one pull request
// the checkout is left on its branch; with several (a batch) it is left on main.
//
// fixture.txt is a list of sections, each opened by a line starting `@@@ `:
//   @@@ base <path>          a file on main
//   @@@ head[:<pr>] <path>   a file as the pull request leaves it (added or changed)
//   @@@ delete[:<pr>] <path> a file the pull request removes
//   @@@ issue[:<n>]          the linked issue's body (title on its first line)
//   @@@ pr[:<n>] [issue]     the pull request's body; the optional second word is its issue
// The PR defaults to 1412 and the issue to 412: the numbers the workflow renders its review
// prompts with. A trailing newline is kept as written; a base path under node_modules/ is
// written but not committed (the fixture's .gitignore names it), as an installed dependency is.
import { readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, readdirSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PR = 1412
export const DEFAULT_ISSUE = 412

export function parseFixture(text) {
  const out = { base: new Map(), prs: new Map(), issues: new Map() }
  const pr = (n) => {
    if (!out.prs.has(n)) out.prs.set(n, { head: new Map(), delete: [], body: null, issue: null })
    return out.prs.get(n)
  }
  let cur = null
  const flush = () => {
    if (!cur) return
    const body = cur.lines.join('\n').replace(/\n*$/, '\n')
    const [kind, num] = cur.kind.split(':')
    const n = num ? Number(num) : null
    if (kind === 'base') out.base.set(cur.arg, body)
    else if (kind === 'head') pr(n ?? DEFAULT_PR).head.set(cur.arg, body)
    else if (kind === 'delete') pr(n ?? DEFAULT_PR).delete.push(cur.arg)
    else if (kind === 'issue') out.issues.set(n ?? DEFAULT_ISSUE, body)
    else if (kind === 'pr') {
      const p = pr(n ?? DEFAULT_PR)
      p.body = body
      p.issue = cur.arg ? Number(cur.arg) : null
    } else throw new Error(`unknown fixture section: @@@ ${cur.kind}`)
  }
  for (const line of text.split('\n')) {
    const m = /^@@@ (\S+)(?: (.*))?$/.exec(line)
    if (m) { flush(); cur = { kind: m[1], arg: (m[2] || '').trim(), lines: [] } } else if (cur) cur.lines.push(line)
  }
  flush()
  if (!out.prs.size) throw new Error('fixture has no pull request (no head, delete or pr section)')
  return out
}

const git = (args, cwd) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-05T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-05T10:00:00Z',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const put = (root, p, body) => {
  if (p.startsWith('/') || p.split('/').includes('..')) throw new Error(`fixture path escapes the workspace: ${p}`)
  mkdirSync(dirname(join(root, p)), { recursive: true })
  writeFileSync(join(root, p), body)
}

// It commits everything it finds and switches branches, so it runs only in an empty directory:
// run by mistake inside a real checkout, it would commit that checkout's work as a fixture.
// The eval harness may have created .claude/ in the workspace already, so that alone is allowed.
export function scaffold(fixture, root = process.cwd()) {
  const f = parseFixture(fixture)
  const present = readdirSync(root).filter((e) => e !== '.claude')
  if (present.length) throw new Error(`refusing to build a fixture repository in a directory that is not empty: ${root} holds ${present.slice(0, 5).join(', ')}`)
  git(['init', '-q', '-b', 'main', '.'], root)
  git(['config', 'commit.gpgsign', 'false'], root)
  for (const [p, body] of f.base) put(root, p, body)
  if ([...f.base.keys()].some((p) => p.startsWith('node_modules/')) && !f.base.has('.gitignore')) put(root, '.gitignore', 'node_modules/\n')
  git(['add', '-A'], root)
  git(['commit', '-q', '-m', 'Initial import'], root)
  mkdirSync(join(root, '.pr'), { recursive: true })
  appendFileSync(join(root, '.git', 'info', 'exclude'), '.pr/\n')
  for (const [n, p] of f.prs) {
    const issue = p.issue ?? (f.prs.size === 1 ? DEFAULT_ISSUE : n - 1000)
    git(['checkout', '-q', '-b', `pr/${n}`, 'main'], root)
    for (const [path, body] of p.head) put(root, path, body)
    for (const path of p.delete) rmSync(join(root, path), { force: true })
    git(['add', '-A'], root)
    git(['commit', '-q', '-m', `Pull request #${n} for issue #${issue}`], root)
    writeFileSync(join(root, '.pr', `${n}.diff`), git(['diff', `main...pr/${n}`], root))
    writeFileSync(join(root, '.pr', `${n}-body.md`), p.body ?? `Closes #${issue}.\n`)
    if (f.issues.has(issue)) writeFileSync(join(root, '.pr', `issue-${issue}.md`), f.issues.get(issue))
  }
  git(['checkout', '-q', f.prs.size === 1 ? `pr/${[...f.prs.keys()][0]}` : 'main'], root)
  return f
}

const isMain = process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  const file = process.argv[2]
  if (!file) { console.error('usage: node scripts/eval-scaffold.mjs <fixture.txt>'); process.exit(2) }
  try {
    scaffold(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`eval-scaffold: ${e.message}`)
    process.exit(1)
  }
}
