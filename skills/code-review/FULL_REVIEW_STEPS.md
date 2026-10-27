# Full-review steps (code-review Steps 3, 6 and 8)

Read by the code-review procedure on a **full** review, including a re-review escalated from a
light one. A light review skips these three steps and says so in its "Scope of this review"
section.

### Step 3: Design Review

**Goal:** Evaluate high-level architecture and design decisions.

After Google's engineering-practices design criteria:

- **Does this change belong here?** Or should it live in a library, another module, or configuration?
- **Integration:** does it fit the existing architecture, or fight it?
- **Abstractions:** are the right ones used? Too many layers? Too few?
- **Coupling:** does this introduce tight coupling between modules?
- **Single Responsibility:** does each new class/function/module do one thing?
- **Over-engineering:** unnecessary generalization or premature abstraction?
- **Patterns:** does it follow existing patterns, or introduce new ones without justification?
- **Consumers:** does anything actually *use* what this adds? An endpoint with no caller and a store
  field nothing renders from are both untested-by-construction. Building an endpoint's first
  consumer is when its defects surface, so an unconsumed one should be called out as unproven.

When a library API's usage looks unusual, verify it against the installed package's source at the
version the lockfile pins (`node_modules/<pkg>`, site-packages, the module cache), not memory. If
it is not installed, say "could not verify" rather than guess: the reviewer has no web tools.

### Step 6: Performance Review

| Pattern | What to Look For |
|---------|------------------|
| **N+1 queries** | Database calls inside loops |
| **Unbounded queries** | Full-table reads without a limit, missing pagination |
| **Memory leaks** | Event listeners not cleaned up, unclosed resources, growing caches |
| **Bundle size** | Large dependencies pulled in for a small feature |
| **Unnecessary re-renders** | Component memoization missing where it demonstrably matters |
| **Blocking operations** | Synchronous I/O on a request or UI thread, long computations without workers |
| **Missing caching** | Repeated expensive computation without memoization |
| **Regex backtracking** | Patterns that can degrade catastrophically (ReDoS) |

### Step 8: Documentation Review

| Check | Question |
|-------|----------|
| **Inline docs** | Are public APIs documented? Are non-obvious algorithms explained? |
| **README** | If behavior changed, is the README updated? |
| **Changelog** | Does the PR follow the project's changelog convention, as `CLAUDE.md` states it? If the project uses per-PR fragments, the PR should add a fragment rather than edit the shared CHANGELOG — a PR editing the shared file directly should be asked to move the entry. A missing entry on a user-facing change is **blocking**, but *presence is a judgment call that nothing automates*, which is why it is asked here: a tests-only or internals-only PR may legitimately carry none, and should say so. |
| **Architecture docs** | If new modules, services, endpoints or schemas were introduced, are the project's architecture docs updated — diagram nodes, project structure, endpoint contracts, tech stack table? Flag as blocking when architectural change ships undocumented. |
| **User docs** | If user-facing features, config options or CLI commands changed, is the user documentation updated? |
| **Agent-instruction file** | Did the PR add to the root `CLAUDE.md` / `AGENTS.md`? That file is injected into every agent session and re-sent every turn, so it is an index: detail, gotchas, measurements and rationale belong in a topic file, with at most a one-line pointer in the root. Flag additions of detail to the root file, "last updated" stamps, and anything that pushes it over a stated size budget (**blocking** if a budget check would fail). |
| **Migration** | If there are schema or API changes, is there a migration — with a working rollback — and a guide where consumers need one? |
| **Removed code** | If features were removed, was their documentation removed too? |
