# Per-project configuration

## The problem

This plugin is generic. Your project is not.

A generic implementer agent does not know whether your tests run with `npm test`,
`pytest -q`, `go test ./...` or `cargo nextest run`. It does not know your coverage floor,
your changelog convention, which directories are off limits, or that your build step chains
an extra asset check onto the end for a reason. Hardcoding any of that would make the plugin
work in exactly one repository.

Nor can the plugin simply *look* — a subagent is dispatched with a prompt and none of the
caller's context. It starts cold, in your repository, with whatever the prompt told it.

## The convention

One sentence, applied everywhere:

> **Every dispatched agent obeys the project's `CLAUDE.md` (or `AGENTS.md`) exactly**,
> because that is where a project states its own hard rules.

Where a project rule conflicts with a plugin default, **the project wins** — that precedence
is stated in each agent and skill, not left to be inferred.

### How the rules reach each agent

Claude Code injects `CLAUDE.md` into every subagent's context at start, including the ones
these workflows dispatch. So the workflows do **not** read it and quote it back into each
prompt — an earlier version did, in a Preflight phase, and paid for the same text two or
three times per dispatch with no gain in adherence.

What the workflows *do* name in every prompt is what is not auto-loaded:

1. **`.claude/delivery.md`** — each agent is told to read it if it exists.
2. **`AGENTS.md`** — for repositories that keep their rules there instead of in `CLAUDE.md`.

### If you have neither file

Nothing breaks. The agents fall back to inferring commands from the repository — package
manifests, `Makefile`, and above all the CI workflow, which is the authoritative statement of
what must pass — and they are instructed to **say in their report what they inferred**.

That last part is the point. An inferred command reported as a known one is how a "green"
claim gets made about a suite that never ran.

---

## The two files

| File | Loaded when | Who reads it | Optional? |
|---|---|---|---|
| `CLAUDE.md` (or `AGENTS.md`) | Automatically, into every session | Everything — Claude Code itself, plus every agent here | Yes, but you want one |
| `.claude/delivery.md` | Only when an agent reads it | This plugin's agents and workflows | Yes. Absence is completely harmless |

### Why the split?

`CLAUDE.md` is loaded into **every** session's context, whether or not you are running this
pipeline. Its cost is paid on every turn of every conversation. That makes it the wrong place
for three paragraphs about how to publish a review payload.

`.claude/delivery.md` costs nothing until a delivery agent reads it. So:

- **`CLAUDE.md`** — facts about the project that any assistant needs: what it is, how to
  build, test, lint and typecheck it, where things live, what must never be committed.
- **`.claude/delivery.md`** — instructions specific to running the delivery pipeline: review
  emphasis, PR conventions, which gates are enforced and at what threshold, known traps that
  have bitten implementers here before.

If you would rather keep one file, keep `CLAUDE.md`. The plugin works fine with only that.

---

## Templates

Two starting points, both meant to be copied and edited:

- [`templates/CLAUDE.md`](templates/CLAUDE.md) → copy to your repository root, if you have
  no `CLAUDE.md` yet.
- [`templates/delivery.md`](templates/delivery.md) → copy to `.claude/delivery.md`.

```bash
mkdir -p .claude
cp /path/to/claude-delivery-plugin/docs/templates/delivery.md .claude/delivery.md
$EDITOR .claude/delivery.md
```

`.claude/delivery.md` is **meant to be committed**. It is a statement about the project, not
about your machine. (`.claude/settings.local.json` is the machine-specific one; that should
stay ignored.)

---

## What makes a good `CLAUDE.md` for this pipeline

The agents ask specific questions of it. Answer these and the pipeline behaves well:

1. **The exact gate commands.** Not "run the tests" — the literal command line, including any
   directory to run it from and any interpreter path. If a repository has two toolchains,
   give both and say which changes require which.
2. **Whether a whole-repo lint is meaningful.** In a tree with pre-existing findings it is
   not, and an agent that does not know this will either report hundreds of unrelated
   findings or conclude the build is broken. Say so, and say to scope lint to changed files.
3. **Coverage floors, and whether they are enforced.** An enforced floor is a merge blocker;
   an aspirational one is not. The difference changes what the implementer does when coverage
   drops.
4. **The changelog convention.** Shared file, per-PR fragments, or nothing. If fragments, give
   the filename pattern and the validator command — a misnamed fragment is typically skipped
   in silence.
5. **Protected paths.** Anything that must never be read, never be committed, or only ever be
   read from one allowlisted directory. State it as an **allowlist** wherever you can: a
   denylist is only as complete as the person writing it, and an agent will reasonably treat
   an unlisted file as permitted.
6. **Branch and remote conventions.** Branch naming, which remote to push to, whether the
   repository has branch protection, and whether the checkout might be shared with another
   session.
7. **How to tell a CI queue from a CI outage**, if you use self-hosted runners. They look
   identical from `gh pr checks`, and an agent that guesses will report a healthy pipeline as
   broken or vice versa.

## What not to put in either file

- **Bare issue references.** `#412` is meaningful inside your repository and meaningless in a
  prompt three hops away. If a past incident justifies a rule, state the rule and the *shape*
  of the incident — "a write that reported success while the read could not see it" — rather
  than the number.
- **Rules you will not enforce.** An agent treats a stated rule as binding. A wish list makes
  it cautious about the wrong things.
- **Secrets, tokens, or internal URLs** that you would not want read into every subagent's
  transcript — which is exactly where both files end up.
