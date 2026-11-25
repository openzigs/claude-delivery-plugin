#!/usr/bin/env node
//
// Fail when a commit's identity metadata carries a private term. Stdlib only.
//
//   node scripts/check-commit-identity.mjs [--base <sha>] [--head <rev>] [--forced true|false]
//
// verify-plugin.mjs reads the TREE. A commit's author, committer and trailers are not in the
// tree, and a push publishes them on this public repository all the same: a commit made on a
// private machine once put that machine's hostname into a `Co-authored-by:` trailer on a
// public openzigs repository. This is the check that stops the next one.
//
// What it reads, for every commit in the range: author name and email, committer name and
// email, every trailer (as git parses them) and the full message. The range is --base..--head
// (a pull request's base..head, a push's before..after), or the last FALLBACK_COUNT commits of
// --head when the base is absent, all zeros (a first push), not a commit the clone holds, or
// --forced true. The clone must hold the history: CI unshallows it first (verify.yml).
//
// The terms are NOT in this repository: a published list of banned words is the disclosure
// the check exists to prevent. They come from PRIVATE_TERMS (a repository secret in CI; one
// term a line, `#` starts a comment, a leading `=` forces a whole-token match) or, locally,
// from the file named by PRIVATE_TERMS_FILE. The tests use invented words.
//
// Matching is the same as the Metis private-vocabulary gate's: a term of 5 or more
// alphanumerics matches as a substring once text and term are lowercased and stripped to
// alphanumerics; a shorter term (or `=term`) must equal a run of whole tokens, the text split
// at non-alphanumerics and camelCase joins, so it cannot fire inside an ordinary word. No
// RegExp is built from a term.
//
// A hit prints the commit SHA and the FIELD, never the term or the matched text, and never a
// trailer key outside a fixed list: the key is text from the commit too, and the Actions log
// is public.
//
// With no list it SKIPS, saying so -- a fork's pull request cannot read the secret. CI sets
// REQUIRE_PRIVATE_TERMS=true on a push and on a pull request from this repository, where a
// missing secret means the check was disarmed, and the skip becomes a failure. A list that
// parses to no terms fails either way: it checked nothing.
//
// Exit codes: 0 clean, or skipped while not required; 1 a hit, an empty list, a required list
// absent, or a range git cannot read; 2 a bad argument.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const MIN_COLLAPSED_LENGTH = 5
const FALLBACK_COUNT = 50
const SKIP_MESSAGE = 'private-terms secret not available: identity check skipped'

// Trailer keys whose NAME may be printed. Any other key is reported by position only.
const NAMED_TRAILERS = new Map(['Co-authored-by', 'Signed-off-by', 'Reviewed-by', 'Acked-by', 'Tested-by',
  'Reported-by', 'Suggested-by', 'Helped-by', 'Co-developed-by', 'Cc', 'Claude-Session', 'Change-Id', 'Refs',
  'Fixes', 'Closes', 'Resolves'].map((key) => [key.toLowerCase(), key]))

const collapse = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '')
const tokenize = (text) => text
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter((token) => token.length > 0)

function parseTerms(raw) {
  const terms = []
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line.length === 0) continue
    const forcedToken = line.startsWith('=')
    const body = forcedToken ? line.slice(1).trim() : line
    const collapsed = collapse(body)
    if (collapsed.length === 0) continue // would match everything
    terms.push({ mode: forcedToken || collapsed.length < MIN_COLLAPSED_LENGTH ? 'token' : 'collapsed', collapsed, words: tokenize(body) })
  }
  return terms
}

function hasTokenRun(tokens, words) {
  if (words.length === 0) return false
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    if (words.every((word, offset) => tokens[start + offset] === word)) return true
  }
  return false
}

function containsTerm(text, terms) {
  const collapsed = collapse(text)
  const tokens = tokenize(text)
  return terms.some((term) => (term.mode === 'collapsed' ? collapsed.includes(term.collapsed) : hasTokenRun(tokens, term.words)))
}

function fail(message, code = 1) {
  console.error(`check-commit-identity: ${message}`)
  process.exit(code)
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const isCommit = (rev) => { try { git(['cat-file', '-e', `${rev}^{commit}`]); return true } catch { return false } }

const options = { base: '', head: 'HEAD', forced: '' }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i], value = argv[i + 1], name = flag?.replace(/^--/, '')
  if (!flag?.startsWith('--') || !(name in options) || value === undefined) fail(`unknown or incomplete argument: ${flag ?? ''}`, 2)
  options[name] = value
}

function loadTerms() {
  const inline = process.env.PRIVATE_TERMS ?? ''
  if (inline.trim().length > 0) return { source: 'PRIVATE_TERMS', raw: inline }
  const file = process.env.PRIVATE_TERMS_FILE ?? ''
  if (file.length > 0) {
    let raw
    try { raw = readFileSync(file, 'utf8') } catch (e) { fail(`PRIVATE_TERMS_FILE could not be read (${e.code ?? 'error'})`) }
    if (raw.trim().length > 0) return { source: 'PRIVATE_TERMS_FILE', raw }
  }
  return null
}

const loaded = loadTerms()
if (loaded === null) {
  if (['1', 'true'].includes((process.env.REQUIRE_PRIVATE_TERMS ?? '').trim().toLowerCase())) {
    fail('private-terms secret not available, and REQUIRE_PRIVATE_TERMS is set: NOTHING WAS CHECKED. ' +
      'On a push or a pull request from this repository the PRIVATE_TERMS secret must exist: restore it, do not unset the requirement.')
  }
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${SKIP_MESSAGE}`)
  console.log(SKIP_MESSAGE)
  process.exit(0)
}

const terms = parseTerms(loaded.raw)
if (terms.length === 0) fail(`the list in ${loaded.source} has no terms, only comments or blanks: nothing was checked.`)
if (!isCommit(options.head)) fail('--head is not a commit this clone holds.')

const base = options.base.trim()
let fallbackReason = ''
if (base.length === 0) fallbackReason = 'no base was given'
else if (/^0+$/.test(base)) fallbackReason = "the base is all zeros (a branch's first push)"
else if (options.forced.trim().toLowerCase() === 'true') fallbackReason = 'the push was forced'
else if (!isCommit(base)) fallbackReason = 'the base is not a commit this clone holds'
const range = fallbackReason ? [`--max-count=${FALLBACK_COUNT}`, options.head] : [`${base}..${options.head}`]
const rangeLabel = fallbackReason ? `the last ${FALLBACK_COUNT} commits, because ${fallbackReason}` : 'base..head'

// One record per commit (-z ends each with NUL); fields split by US (0x1f), trailers by GS
// (0x1d). The message is the LAST field so a stray separator in it stays in it. %an/%ae/%cn/%ce
// are the raw identities, not .mailmap's rewrite: the raw ones are what a push publishes.
const FORMAT = ['%H', '%an', '%ae', '%cn', '%ce', '%(trailers:only=true,unfold=true,separator=%x1d)', '%B'].join('%x1f')
let output
try { output = git(['log', '-z', '--no-color', `--format=${FORMAT}`, ...range, '--']) } catch { fail(`git log could not read ${rangeLabel}. Is the clone shallow?`) }

const records = output.split('\0').filter((record) => record.length > 0)
const hits = []
for (const record of records) {
  const parts = record.split('\x1f')
  const sha = parts[0] ?? ''
  // Fail closed: a record this script cannot take apart is not a clean one.
  if (parts.length < 7 || !/^[0-9a-f]{40,64}$/.test(sha)) fail('git log printed a record this script could not parse, so it was NOT checked.')
  const [, authorName, authorEmail, committerName, committerEmail, trailerBlock] = parts
  const fields = [
    ['author name', authorName],
    ['author email', authorEmail],
    ['committer name', committerName],
    ['committer email', committerEmail],
  ]
  trailerBlock.split('\x1d').filter((t) => t.trim().length > 0).forEach((trailer, index) => {
    const named = NAMED_TRAILERS.get(trailer.slice(0, Math.max(0, trailer.indexOf(':'))).trim().toLowerCase())
    fields.push([named ? `${named} trailer` : `trailer ${index + 1} (key not shown)`, trailer])
  })
  fields.push(['commit message', parts.slice(6).join('\x1f')])
  for (const [field, text] of fields) if (containsTerm(text, terms)) hits.push({ sha, field })
}

if (hits.length > 0) {
  console.error('Private terms found in commit identity metadata:\n')
  for (const hit of hits) {
    console.error(`  ${hit.sha}  ${hit.field}`)
    if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error::commit ${hit.sha}: private term in its ${hit.field}`)
  }
  console.error('\nThe matched text is deliberately not shown: this log may be public. Rewrite the commit\'s identity ' +
    'or message (git commit --amend --reset-author, or a rebase) before it reaches main; once it is there, it is history.')
  process.exit(1)
}

console.log(`check-commit-identity: ${records.length} commit(s) in ${rangeLabel} scanned against ${terms.length} private term(s) from ${loaded.source}, none found.`)
