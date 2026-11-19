# Working across many issues without one endless session

Keeping one Claude Code session open for weeks and moving from issue to issue feels like it
preserves memory. Measured on real projects, it does not, and it costs more per step than a
fresh session. This page says what the measurements were, what to do instead, and what a
project needs for it to work.

## What long sessions actually do

From the main-session transcripts of three real repositories (the four longest sessions ran 15 to
50 days and 2,779 to 13,715 model calls each):

| Observation | Measurement | What it means |
|---|---|---|
| The session is compacted over and over | 12 to 108 compactions per session, about one every 170 model calls | The model is already forgetting. A compaction is a lossy summary nobody chose the contents of |
| Every call re-reads a large context | Median context 179k to 617k tokens; three sessions peaked at 967k | A call costs about 1.7 times what it costs in a session under 200 calls |
| Coming back after an hour re-writes everything | 471 returns after a gap of more than an hour, 14% of main-session cost | The main session's prompt cache lasts an hour. After that the whole context is written again |
| A third of the calls are status checks | About 9,200 of 30,914 calls were `gh` reads, `git` reads and sleep-and-wait loops | Each check pays for the whole context, to learn what a notification would have said |

Main sessions were 11% of total spend on those projects; dispatched agents were the other 89%.
So this is not the largest cost, and the changes below save roughly a third to a half of that
11%. The stronger reason to change is memory: what is written down is the same on day 40 as on
day 1, and what is only in the conversation is not.

## The method: keep the memory outside the conversation

There are three kinds of thing a session "remembers", and each has a better home.

| What | Where it should live | Who reads it |
|---|---|---|
| What was done and why | GitHub: the issue, the PR body (with its acceptance-criteria list), the published review | Anyone, any session, any agent |
| Lessons about this codebase | `.claude/delivery.md`: gates, review emphasis, known traps, owner-only criteria | Every dispatched agent, on every run |
| Where the work stands right now | `.claude/handoff.md`, written by `/delivery:handoff` | The next main session |

Only the third is new. The first two already existed; a long session simply hid how little the
conversation itself needed to hold.

## A working day, start to finish

**Start of a session.** Type:

```
/delivery:handoff resume
```

It reads `.claude/handoff.md`, re-runs the facts script, and reports what the note said, what has
changed since (a PR merged, a review that arrived, CI that turned), and the next step. It does
not start anything until you say so. With no note it says there is nothing to resume.

**Take work forward with one command per epic, and do not poll.**

```
/delivery:orchestrate --epic 47
```

The workflow runs in the background and notifies the session when it finishes. Asking the model
to "check on it" every few minutes pays for the whole context each time and learns nothing a
notification would not have said. If you want to watch, `/workflows` shows live progress without
a model call.

**When a run finishes**, read the result's `awaitingOwner` (PRs waiting on you) and any PR with
`stillBlocking: true`. Clear what is yours, then send those PRs back through review:

```
/delivery:orchestrate --pr 88 91
```

**Before you stop, switch epics, or step away for more than an hour**, type:

```
/delivery:handoff
```

then `/clear`, or close the session. Returning to a 300k-token context after an hour costs about
600k token-equivalents before the model does anything; a fresh session starts at about 30k.

**Once a week or so**, ask what the reviews keep finding and move the answer into the project:

```
/delivery:retro --discover --last 50
```

Ask it what to add to `.claude/delivery.md`; it drafts the lines in its reply and you paste the
ones you agree with. That is how a lesson reaches every future agent instead of living in one
session's summary.

## What a handoff note looks like

```markdown
# Handoff

### State on 2026-11-19 — acme/storefront

**Open pull requests (3)**

- #88 Resolve #71 — date-range filter — branch `feature/issue-71-date-range`, CI passing, last review: merge with follow-ups — 2 non-blocking findings, updated 2026-11-18
- #91 Resolve #74 — export totals — branch `feature/issue-74-export-totals`, CI passing, last review: do not merge — 1 blocking finding, updated 2026-11-19
- #92 Resolve #75 — empty state copy — branch `feature/issue-75-empty-state`, CI passing, last review: do not merge — 1 blocking finding, updated 2026-11-19

**Open epics (1)**

- #47 [EPIC] Reporting screen

**Left open by the last 10 saved orchestrate run(s)**

- Waiting on the owner or on CI, no fix ran: #92
- Still blocking after the re-review: #91
- Review never returned: none
- Issues not implemented or with no PR: none

### In flight
- none

### Decisions made, and why
- Totals are rounded per line, not on the sum: finance reconciles line by line (#74 comment).
- #76 is deferred until the currency work lands; do not start it.

### Next step
Approve the empty-state wording on #75, then `/delivery:orchestrate --pr 91 92`.

### Do not redo
- Caching the export query: tried in #91, it leaked rows across accounts and was reverted.
```

Everything above `### In flight` is printed by `scripts/handoff.mjs` from GitHub and the saved
runs. The model writes only the four short sections below it, from what you said and decided in
the session, in at most 30 lines.

## What to add to a project

Nothing is required. `/delivery:handoff` works in any repository. Three small additions make the
method hold up:

1. **Ignore the note.** It is one person's working state, not project documentation:

   ```
   # .gitignore
   .claude/handoff.md
   ```

   Commit it instead only if a team hands work to each other through it. The skill tells you
   once if the file is not ignored.

2. **Create `.claude/delivery.md`** if the project has none, from
   [`templates/delivery.md`](templates/delivery.md). Its `Known traps` and `Review emphasis`
   sections are where lessons go, and one more section is worth adding now that reviews say who
   can clear a blocker:

   ```markdown
   ## Owner-only criteria

   - Any change to user-visible wording needs the owner's approval in a comment on the issue.
   - Layout changes need before/after screenshots on a phone and a tablet, approved by the owner.
   ```

   With that written down, the implementer lists such a criterion as `owner:` in the PR body
   instead of marking it met, and the reviewer marks it `owner` instead of sending it to a fix
   pass that cannot clear it.

3. **Give issues a `Story Points` line.** It is what lets a small issue take the small tier
   without a hint. `/delivery:plan-epic` writes it; `/delivery:doctor` reports how many open
   issues have one.

Optionally, one line in `CLAUDE.md` makes a fresh session offer to resume without being asked.
Keep it to one line, because that file is injected into every agent:

```markdown
- In an interactive session, if `.claude/handoff.md` exists, offer `/delivery:handoff resume` before starting new work.
```

## What this does not do

- It does not make a session cheaper while it runs; it makes sessions shorter. The dominant cost
  of the pipeline is still the implementer's own context, which the 270-second CI wait and the
  `--per-issue` flag address.
- A handoff is not shared memory between agents. Dispatched agents never read it; they read
  `CLAUDE.md` and `.claude/delivery.md`.
- The note is a snapshot. `resume` refreshes the facts, but a decision recorded last week may
  have been overtaken; that is why resuming reports and then waits.
