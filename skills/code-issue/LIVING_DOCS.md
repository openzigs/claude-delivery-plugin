# Living documents (code-issue Step 5.5)

Read by the code-issue procedure before creating a PR that changes behaviour, architecture,
configuration or documentation.

After implementation and before creating the PR, update the project's living documents if they
exist. **If a document does not exist, skip it — do not create it here.**

#### Changelog

Follow the project's changelog convention if it has one — `CLAUDE.md` states it. **If it uses
per-PR fragments, add a fragment rather than editing the shared CHANGELOG.** A shared-file
convention puts every open PR on the same anchor line, so the first merge conflicts every other
branch and each one pays a rebase; a fragment is a new file and merges silently. **Run whatever
fragment validator the project ships** — a misnamed fragment is typically skipped in silence at
assembly. Never bump a version unless the project says that is part of a PR.

#### Architecture documentation

Update if this issue introduced new modules, services or components; new API endpoints or schemas;
changes to system architecture or the flow of information; new dependencies or integrations; or
infrastructure changes. Add the new components to the architecture diagram, update the project
structure section, document new endpoint contracts with request/response shapes, update the schema
section if it changed, and extend the technology stack table for new dependencies.

#### User documentation

Update if this issue introduced user-facing features or pages, changed an existing workflow, added
configuration options, or added CLI commands. Document new features with examples, update getting
started if onboarding changed, document new options with their defaults, and extend the FAQ where
you can anticipate the question.

#### The repository's agent-instruction file

`CLAUDE.md`, `AGENTS.md` or `.github/copilot-instructions.md` is **injected into every agent session
and every dispatched subagent, and re-sent on every turn**. Every byte added to it is paid again by
every future agent, for as long as it stays. So it is an index, not a notebook. Repositories where
agents appended a little on each PR have grown it to hundreds of kilobytes in weeks, and the size
became the largest cost of working in them.

Change it only when the change affects how a future agent would navigate or build this repository:

| Change Type | Example | Where it goes |
|---|---|---|
| New top-level module or service | Added `src/payments/` | One line in the index's layout section |
| New build/test/run command | Added a migration script | One line in the index's commands section |
| New coding convention, CI check or lint rule | Adopted schema validation; added a typecheck step | The matching topic file; the index only if it is a hard rule every task must know |
| Non-obvious gotcha you actually hit | A tool resolves to a system install | The matching topic file |
| Measurements, decisions, history, rationale | Timings, why a library was chosen | The topic file, an ADR or the PR body — never the index |
| Routine bug fix, small feature or test | Fixed a null check | Nowhere |

Rules:

- **Detail goes in a topic file, not the root file.** If the project keeps agent docs under a
  directory (for example `docs/agents/`, `docs/`, or files the root file links to), put the detail
  there. In the root file, add **at most one line**, and only when you create a new topic: a pointer
  saying which file to read and when.
- **Respect the budget.** If the root file states a size budget, or a check enforces one, stay under
  it. If it states none and is already over ~40 KB, do not add to it at all. Put the detail in a topic
  file and say in the PR body that the root file should be split.
- **Surgical edits only.** Update the relevant line in place; never rewrite or reorder the file in a
  feature PR.
- **No stamps.** Do not add "last updated" markers or authorship comments. Git already records that,
  and in an injected file a stamp is churn every agent pays for.
