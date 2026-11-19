---
name: handoff
description: Writes, or reads back, a short handoff note so delivery work can continue in a fresh session without one endless conversation. Use when the user is about to clear the session, stop for the day, or step away for more than an hour ("write a handoff", "wrap up", "save where we are"), and at the start of a new session ("resume", "pick up where we left off", "what was I doing"). Writing gathers open pull requests, open epics and what the last orchestrate runs left unfinished with the plugin's own script, adds the decisions and the next step from this conversation, and saves .claude/handoff.md. Resuming reads that note, refreshes the facts, and reports what changed. It dispatches nothing and changes nothing on GitHub.
argument-hint: "[name] | resume [name] — no argument writes the note; 'resume' reads it back; a name keeps one note per workstream"
---

# Handoff

A long session does not keep memory: it is compacted, lossily, about every 170 model calls, and
every call re-reads the whole context. What survives reliably is what is written down. This
skill writes down the little that GitHub does not already hold, so the next session can start
clean and cheap.

The arguments for this run: `$ARGUMENTS`

## What this skill may and may not do

It runs the facts script, and it reads and writes **one file**: the note for this run, in the
current repository. That is `.claude/handoff.md`, or `.claude/handoff-<name>.md` when a name was
given. It runs no other GitHub command, dispatches no agent, and never edits
`CLAUDE.md`, `AGENTS.md` or `.claude/delivery.md`: a lesson worth keeping for every future agent
is proposed to the maintainer in your reply, not written by you.

The facts script is the only source for the state of pull requests, epics and past runs. Do not
restate them from memory of this conversation: after a compaction that memory is a summary, and
the script is current.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/handoff.mjs"
```

## Which note: one per workstream

A session that works one thing uses the unnamed note. Two sessions on different work in the same
checkout would overwrite each other's decisions in it, so each takes a name:

| Arguments | Note | Does |
|---|---|---|
| *(none)* | `.claude/handoff.md` | writes |
| `connect` | `.claude/handoff-connect.md` | writes |
| `resume` | `.claude/handoff.md` | reads back |
| `resume connect` | `.claude/handoff-connect.md` | reads back |

A name is lowercase letters, digits and hyphens, and is never `resume`. Anything else: say what a
valid name looks like and stop, writing nothing. The script's output ends with the notes that
exist in this checkout; use that list, never a guess, to say which notes there are.

## With no argument, or a name: write the note

1. Run the script above.
2. **Account for every agent this session dispatched outside a workflow.** The script sees only
   workflow runs and pull requests, so an agent dispatched directly from this session, in the
   foreground or the background, reaches the note only through you. Go back
   through this session's agent results and, for each one:
   - **finished**: if it found, decided, changed or ruled out something that did not end in a pull
     request, put that under "Decisions made, and why" or "Do not redo", naming the agent's task.
     A pull request it opened is already in the facts; do not repeat it;
   - **still running**: list it under "In flight" with what it was doing, and tell the user, before
     anything else in your reply, not to `/clear` or close the session until it reports back,
     because a background task ends with its session. The same holds for a workflow still running.

   Report only what an agent's returned result says. An agent whose result you cannot find in this
   session is listed under "In flight" as unknown, not guessed at.
3. Write the note for this run, replacing any earlier one of the same name, with exactly these
   sections:

   ```markdown
   # Handoff

   <the script's output, verbatim, starting at its "### State on" line>

   ### Scope
   - <named notes only: the epic, issues and pull requests that are this workstream's, by number>

   ### In flight
   - <a workflow or agent still running, or a step started and not finished, with what to check>

   ### Decisions made, and why
   - <a choice the user made in this session that a newcomer would otherwise re-open>

   ### Next step
   <the one command or action to start with, written so it can be typed as is>

   ### Do not redo
   - <something already tried or ruled out, and what ruled it out>
   ```

4. Keep everything below the script's output to **at most 30 lines**. A section with nothing in it
   says `- none`. Write only what the user said or decided, or what a tool result in this session
   showed. If you are unsure whether something was decided, leave it out: an invented decision
   in a handoff is acted on by a session that cannot ask where it came from.
5. Put no secret, token or credential in the note, and no content from a path the project
   protects.
6. Tell the user, in two lines: which note is saved, and that to continue they start a fresh
   session (or `/clear`) and type `/delivery:handoff resume`, with the name if the note has one.
   If the script's output says git does not ignore the notes here, pass that on once.
   An unnamed note has no Scope section.

## With `resume`: read the note back

1. Run the script above for the current facts and the list of notes.
2. Read the note for this run. If it does not exist, say so and stop: there is nothing to resume.
   If no name was given and the unnamed note does not exist but named ones do, list them from the
   script's output and ask which one; do not pick.
3. Report, briefly: what the note says was in flight and decided; **what has changed since it was
   written** (a pull request merged or closed, a review that arrived, CI that turned); and the
   note's next step, corrected if the current facts overtook it.
4. Stop there. Do not start the next step until the user says to: a handoff describes intent
   from an earlier session, and resuming is a moment to confirm it.

## What does not belong in the note

- What GitHub already records: the content of an issue, a PR body, a review. Name the number.
- A lesson every future agent needs, such as "fixtures here hide mixed-case emails". That belongs in
  `.claude/delivery.md`, which reaches dispatched agents; a handoff reaches only the next main
  session. Say it in your reply so the maintainer can add it.
- A transcript of the session. Thirty lines that are right beat three hundred that are complete.
