# Default labels and story points (epic-planner)

Read by the epic-planner procedure before filing, when the project's `CLAUDE.md` defines no
taxonomy of its own.

## Labels

Create and use these labels on every issue. If the label doesn't exist in the repo, create it.
If the project's own `CLAUDE.md` defines a different taxonomy, follow that instead.

| Label | Color (hex) | Description |
|-------|-------------|-------------|
| `epic` | `7057ff` | Top-level planning epic |
| `feature` | `1d76db` | New feature or enhancement |
| `frontend` | `0075ca` | Client, UI, styling work |
| `backend` | `d93f0b` | Server-side / API work |
| `database` | `0e8a16` | Schema, migrations, data access |
| `infra` | `fbca04` | Build, CI/CD, deployment config |
| `docs` | `d4c5f9` | Documentation updates |
| `testing` | `bfd4f2` | Test coverage and QA |
| `security` | `b60205` | Security-related work |
| `blocked` | `e4e669` | Waiting on another issue |

```bash
gh label create epic --color 7057ff --description "Top-level planning epic" 2>/dev/null \
  || gh label edit epic --color 7057ff --description "Top-level planning epic"
```

## Story Points (Fibonacci Scale)

| Points | Meaning | Example |
|--------|---------|---------|
| 1 | Trivial | Config change, copy update |
| 2 | Small | Simple component, single endpoint |
| 3 | Medium | Feature with tests, moderate complexity |
| 5 | Large | Multi-file feature, integration work |
| 8 | Very Large | Complex feature, significant refactor |
| 13 | Epic-sized | Should probably be split further |
