---
name: research-gather
description: "Gathers and converts research material into Markdown from local documents (Word, PDF, spreadsheets, slides), the repository itself, web pages, and library documentation. Produces a structured research summary — with sources, versions, and an explicit list of what could not be confirmed — for epic planning. Use when asked to research, gather requirements, pull in docs, or analyze documents before planning."
argument-hint: "[topic or path] — describe what to research, or provide a local directory path"
---

# Research Gather

## Purpose

This skill collects and converts research material from multiple sources into Markdown for use
by the **`delivery:research`**, **`delivery:code-planner`**, and **`/delivery:epic-planner`**
workflows. It bridges the gap between raw requirements material — local files, the codebase,
web content, library docs — and structured GitHub issues.

Invoke it directly as `/delivery:research-gather`. The `/delivery:plan-epic` workflow runs this
skill and then hands its summary to the epic planner for you.

## When to Use

- Before epic planning, to gather requirements and context
- The user has local documents (Word, PDF, spreadsheets, slides) to analyze
- The user provides web URLs with reference material, specs, or designs
- The user needs the shape of a library, format, or protocol pinned down before work is scoped
- The user says "research", "gather requirements", "pull in docs", or "analyze documents"

## Before You Start: Read the Project's Own Rules

**The project's `CLAUDE.md` is normally already in your context; read it only if it is not.**
Obey it exactly. If there is no `CLAUDE.md`, read `AGENTS.md`. If `.claude/delivery.md` exists,
read it too. If the repository has neither `CLAUDE.md` nor `AGENTS.md`, infer the commands and
conventions from the repository itself (manifests, CI workflow) and say in your report what you
inferred. That is where a project states its own hard rules: architecture, build and
test commands, protected paths, data-handling rules, and its label and milestone conventions.

Two of those rules bite hardest during research, because research is a reading activity:

- **Protected paths.** Some repositories forbid reading certain files at all — regulated data,
  customer exports, credentials, licensed corpora. Reading such a file into a transcript can be
  as unrecoverable as committing it. If the project names protected paths, do not open them, do
  not grep them, and do not ask a subagent to. If a tool refuses a read, that is the control
  working; read the refusal message rather than routing around it.
- **Where the answer is allowed to come from.** If `CLAUDE.md` states which files are canonical
  for a subject, prefer them over anything you find on the web.

## The Rule That Makes Research Usable: Say What You Could Not Confirm

A research summary is not a place to sound confident. Whatever you write here is copied into an
epic, and from the epic into every sub-issue below it, and is usually not re-checked until an
implementer hits it. **An open question costs one round-trip. A confident wrong answer costs a
correction sweep across a dozen issues.**

So:

- **Never assert a dependency, a version, or an API shape you did not read.** If you did not
  open the manifest, the lockfile, or the documentation page, it goes under "Could Not Confirm",
  not into the requirements list.
- **Attribute every claim to its source**, by filename or URL, at the point you make it.
- **Distinguish "the docs say" from "this repository does".** They disagree more often than not.
- **Flag contradictions between sources** rather than silently picking a winner.
- Writing "I could not determine which authentication scheme the upstream API uses" is a
  finished, useful research output. Guessing is not.

## Version Every Format, Protocol and API Claim

**A spec name is usually not one thing.** File formats gain fields between revisions, wire
protocols renumber their status codes, and library APIs rename or remove functions across major
versions. A claim recorded without its version is not usable by whoever reads it next — they
cannot tell whether it applies to the version this project actually has.

Record, for every technical claim:

- **Which version** the claim applies to — the format revision, the protocol version, the
  library's major.minor.
- **Which version this project uses** — read it from the manifest or lockfile, not from memory.
- **Whether those are the same.** If they are not, say so explicitly; that gap is a finding in
  its own right.

Worked example. "The export file has a header row" is not a usable claim about a CSV interchange
format if v1 of that format had five columns, v2 added two optional ones, and the file the
project actually ingests is v1 with a vendor extension. Write it as: *"Format v2 defines seven
columns, the last two optional (source: vendor spec PDF, p. 14). The fixtures in this repository
are v1 with five columns (source: `tests/fixtures/sample-export.csv`). The importer does not yet
detect the version. Open question: which versions must be supported?"*

The same discipline applies to a library: "the client exposes `createSession()`" is worth
nothing without "in 4.x; this project pins 3.2, where it is `newSession()`".

## Tools

**Nothing in this skill requires an MCP server.** Local files, `WebSearch`/`WebFetch`, and the
`gh` CLI cover every step. Optional servers, when configured, make some steps faster.

| Need | Always available | Optional accelerator |
|------|------------------|----------------------|
| Read local files | `Read`, `Glob`, `Grep` | — |
| Convert Word/PDF/spreadsheet/slides to Markdown | A local converter run via `Bash` | a document-conversion MCP tool, if one is configured |
| Web discovery | `WebSearch` | Tavily search |
| Fetch a known URL | `WebFetch` | Tavily extract |
| Library documentation | `WebSearch` + `WebFetch` on the official docs | Context7 resolve + query |
| Repository and issue context | `gh issue list`, `gh issue view`, `gh search code` | — |

If an optional server is present, use it — it is usually faster and better structured. If it is
not, proceed with the always-available column and note in the summary which source you used.
Never tell the user to install a server, and never let a step depend on one.

## Workflow

### Step 1: Choose the Sources

When invoked interactively, present this menu. When dispatched, do not present it: a path or URL
in the request is the primary source; otherwise use this repository plus web and library docs in
proportion, and record the sources you chose and why.


> **Where should I gather research material from?** (Choose all that apply)
>
> 1. **Local directory** — convert documents from a folder on disk (Word, PDF, spreadsheets,
>    slides) to Markdown
> 2. **This repository** — read the code, manifests, tests and docs that already exist
> 3. **Web URLs or search** — fetch pages you name, or search for specs and prior art
> 4. **Library docs** — look up framework or library documentation
>
> *Provide paths, URLs, search terms, or topics for each source.*

Offer no source you cannot actually reach: offering a capability you do not have is the same
failure as asserting a fact you did not check. Planning is not a source: to research and then file
an epic in one step, the user runs `/delivery:plan-epic`, which runs this skill first.

### Step 2: Local Documents (if selected)

#### 2a. Get the Path
If not already provided:
> *"What is the path to your local documents?"*

Check it against the project's protected paths before opening anything.

#### 2b. Convert Documents to Markdown
If a document-conversion tool is configured, use it — point it at the directory, set recursion
for nested folders, and send the Markdown to a separate output directory if the user wants the
originals left alone. These converters are normally idempotent, so re-running skips files that
are already converted.

Without one, convert via whatever the environment already has (a Python or Node converter, a
command-line extractor) run through `Bash`, or read text-based files directly. Plain text and
Markdown need no conversion at all; binary formats lose their formatting if you fall back to a
raw text extraction, so note that in the summary when it happens.

#### 2c. Read and Analyze
- Read the generated Markdown
- Extract requirements, business rules, data models, and specifications
- **Note the source file, and the page or section, for every finding** — the epic will cite it
- Record the document's own date or revision; a superseded spec looks identical to a current one

### Step 3: The Repository Itself (if selected)

This is the step most likely to be skipped and most likely to matter. **Verify technical claims
against the project's own source, not against the web.** The web tells you what is idiomatic;
only the repository tells you what this codebase actually does.

- **Dependencies and versions** — read the manifest and the lockfile. The lockfile is the truth;
  the manifest is a range.
- **What is actually imported** — grep for the import or include. A dependency listed in the
  manifest and imported nowhere is not part of this system.
- **Existing patterns** — find two or three places that already solve a similar problem, and
  record their file paths. New work should look like them.
- **Tests and fixtures** — the fixtures encode the real shape of the data far more reliably than
  any document about it.
- **Existing issues** — `gh issue list --state open --limit 200` and
  `gh issue list --state all --search "<terms>"`. Research that ignores the backlog produces a
  plan that duplicates it. Some projects also commit a backlog dump under their docs directory;
  read it if it exists, but trust `gh` over it.

When a document and the repository disagree, the repository wins for "what is", the document
wins for "what should be", and **the disagreement itself is a finding** — record it.

### Step 4: Web Research (if selected)

#### 4a. Get URLs or Search
Infer URLs from the request and the project context. When invoked interactively you may also ask:
> *"What URLs should I fetch — documentation, design specs, API references?"*

#### 4b. Fetch and Parse
- Open-ended discovery — `WebSearch` (or Tavily search, if configured)
- A specific known URL — `WebFetch` (or Tavily extract, if configured)
- Prefer primary sources: the official documentation, the standard, the vendor's own reference.
  A blog post is evidence that a pattern exists, not evidence of an API's current shape.

#### 4c. Extract Insights
- Summarize the relevant content, and keep the URL for citation
- Record the publication date and the version the page describes
- Separate "this is the general pattern" from "this is how our stack does it" — only the second
  belongs in an acceptance criterion, and only after Step 3 confirms it

### Step 5: Library Documentation (if selected)

#### 5a. Identify Libraries
From the project's manifest and the user's description, identify the libraries that matter.
Start from what the project already depends on — not from what you would choose.

#### 5b. Resolve and Query
If a docs MCP server is configured, resolve the library id and query it for the specific
patterns, setup steps, and pitfalls you need. Otherwise search for the official documentation
and fetch the relevant pages.

Either way, **query the version the project pins**, and say so in the summary. Documentation
sites default to latest, which is frequently not what the lockfile says.

### Step 6: Compile Research Summary

Produce a structured summary that `/delivery:epic-planner` can consume directly:

```markdown
## Research Summary

### Sources Consulted
| Source | Type | Version / Date | Key Findings |
|--------|------|----------------|--------------|
| {document or URL} | Local / Repo / Web / Docs | {rev or date} | {1-line summary} |

### Requirements Extracted
#### Functional Requirements
1. {FR-001}: {description} *(Source: {document}, {section})*
2. {FR-002}: {description} *(Source: {document}, {section})*

#### Non-Functional Requirements
1. {NFR-001}: {description} *(Source: {document})*

#### Business Rules
1. {BR-001}: {description} *(Source: {document})*

### Data Model Insights
{Schemas, entity relationships, and data structures identified — with the source for each}

### Formats, Protocols and APIs
| Thing | Version described by the source | Version this project uses | Same? |
|-------|--------------------------------|---------------------------|-------|
| {format / protocol / library} | {v} | {v, from the lockfile} | yes / no / unknown |

### Integration Points
{External systems, APIs, or services identified}

### User Roles & Permissions
{User types and their access levels}

### What This Repository Actually Does
{Findings from Step 3: real dependencies, real patterns, real fixtures — with file paths}

### Technology Recommendations
{From the library docs research — frameworks, tools, patterns, each tied to a source}

### Could Not Confirm
1. {Claim I could not verify, and what would verify it}
2. {Source I could not access, and what it would have told us}

### Open Questions
1. {Question needing user clarification}
2. {Ambiguity or contradiction found between sources}

### Constraints & Assumptions
- {Constraint or assumption identified during research, and which source it came from}

### Security Considerations
- {Security requirements, compliance needs, or sensitive-data handling noted in the sources}
```

If a workflow or another agent dispatched you, skip the question below: return the summary as
your report, with any locally cached confidential documents named in it.

Present the summary to the user and ask:
> *"Here's what I found, including what I could not confirm. Any corrections, additions, or
> questions you'd like me to resolve before I start planning the epics?"*

If confidential documents were converted and cached locally, also note:
> *"Those documents are cached locally. Tell me when you're done and I'll remove them."*

### Step 7: Handoff to Epic Planner

Pass the research summary to `/delivery:epic-planner` as
context for issue creation. Carry the **Could Not Confirm** and **Open Questions** sections
across verbatim — they belong in the epic's own Open Questions section, not on the floor. An
epic that silently resolved an open question is worse than one that admits it.

## Error Recovery

| Scenario | Action |
|----------|--------|
| Local path doesn't exist | Interactive: ask the user to verify the path. Dispatched: list it as unread under "Could Not Confirm" and continue |
| Path is protected by project rules | Do not read it; tell the user which rule matched |
| A read is refused by a project guard | Read the refusal message; it names the file and the rule. Do not route around it |
| File conversion fails | Log the error, skip the file, continue with the others, list it as unread |
| No converter available | Fall back to direct reading for text-based formats; note the loss of fidelity |
| Web fetch fails | Note the URL as inaccessible under "Could Not Confirm", continue |
| Search returns nothing useful | Broaden the terms, try the primary source directly, then say so |
| An optional MCP server is absent | Use the always-available equivalent; do not tell the user to install anything |
| Sources contradict each other | Record both and name the contradiction as an open question — do not pick silently. Ask the user only when interactive |

## Tips

- For large document sets, prioritize the most recent and most relevant; say which ones you did not read
- Cross-reference findings across sources — agreement between two independent sources is worth recording as such
- Keep the summary concise; detail belongs in the individual epic and issue bodies it feeds
- Where local documents and web sources overlap, note both the overlap and the discrepancies
- Re-running a document conversion over the same directory is normally safe and skips what is already converted
- Every claim gets a source and a version. A claim with neither is an open question wearing a suit
- Finish by asking yourself the only question that matters here: *which sentence in this summary
  would be most expensive if it turned out to be wrong, and did I actually read it somewhere?*
