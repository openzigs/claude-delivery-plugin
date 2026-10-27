# Stack guide (repo-scaffold Steps 2 and 4)

Read by the repo-scaffold procedure in Step 2, to recommend a stack, and in Step 4, to scaffold
the confirmed one. These are starting points for a recommendation, not a house style.

## Choosing a stack

#### Frontend Projects (Web App, Full-Stack frontend)

**A common default**: React + Tailwind CSS + an accessible headless component library
(Radix UI, Ark UI, or React Aria). Vue + Nuxt, Svelte + SvelteKit and Solid are legitimate
answers when the user or the team already leans that way — ask before assuming React.

Research the shortlist before recommending:
- Resolve the framework in Context7 if configured and query "project setup / scaffolding /
  getting started", otherwise `WebSearch` for the framework's current quickstart.
- Confirm the **current major version** and its scaffolding command. These change often, and
  a stale `create-*` invocation is the most common scaffold failure.

**Decision tree**:
- Needs SSR, SEO, or file-based routing → a meta-framework (**Next.js** App Router,
  **Nuxt**, **SvelteKit**, **Remix**)
- Pure SPA, no SSR needed → **Vite** + the chosen UI library
- Content-heavy site → **Astro** (with islands)
- Simple static site → **Astro** or a Vite SPA

**Usually include, whatever the framework**:
- A styling approach the team will actually keep (utility CSS, CSS modules, or a
  design-system package)
- Accessible component primitives rather than hand-rolled dialogs and menus
- TypeScript in strict mode
- A linter and a formatter, configured and wired into the CI gate
- A unit test runner (Vitest, Jest, or the framework's own)
- A browser e2e runner (Playwright or Cypress) if there is a UI

#### Backend Projects (API Server, Full-Stack backend)

Research the best fit based on the project requirements. None of these is the default; the
requirements pick one:

| Consideration | Candidate stack | When |
|---------------|-----------------|------|
| Simple REST API, rapid development | **Node.js/TypeScript + Fastify or Express**, or **Hono** on an edge runtime | Most web APIs, CRUD apps, real-time features |
| Complex business logic, enterprise integration | **Java + Spring Boot**, or **C# + ASP.NET Core** | Heavy ORM needs, complex transactions, existing JVM/.NET estate |
| Data science, ML, scientific computing | **Python + FastAPI** (or Litestar/Django REST) | ML pipelines, data processing, numeric workloads |
| High performance, high concurrency | **Go + Chi/Gin/Echo** | Microservices, high-throughput, low-latency |
| Systems programming, WASM, strict resource limits | **Rust + Axum/Actix** | Performance-critical, memory-safe systems |
| Team already fluent in something else | **That** | Fluency beats benchmark deltas on almost every project |

Persistence, likewise, is a question and not a given — relational (PostgreSQL, MySQL,
SQLite), document, key-value, or no database at all. Ask what the data looks like and how it
will be queried before naming a product, and let the ORM/query-builder follow the database
rather than the other way round.

For each candidate, check current setup docs (Context7 if configured, otherwise
`WebSearch`/`WebFetch`) so the scaffold command and version pins you emit are real.

Present the recommendation with reasoning:

```markdown
## Tech Stack Recommendation

### Frontend
- **Framework**: {framework + major version}
- **Styling**: {approach}
- **Components**: {library}
- **Language**: {language + mode}

### Backend
- **Runtime**: {runtime + LTS version}
- **Framework**: {framework + version}
- **Language**: {language + mode}
- **Data**: {database + access layer, or "none"}

### Reasoning
[Why this stack fits the described project — tie each choice to a stated requirement]

### Alternatives Considered
[What else was on the shortlist and the specific reason it lost]
```

#### CLI Tools

Ask how it will be distributed, because that decides the language more than anything else:
a single static binary points at **Go** or **Rust**; `npx`-able tooling for a JS ecosystem
points at **Node.js/TypeScript**; something that must sit alongside a data stack points at
**Python** with a modern packaging tool. Whatever wins, include argument parsing, `--help`
output, exit codes, and a test that runs the binary end to end.

#### Libraries / Packages

The registry the consumers already use decides the language. Pin down the public API surface
and the supported runtime versions in the interview, and set up the release and versioning
story (semver, a changelog convention, a publish workflow) at scaffold time rather than
retrofitting it under time pressure later.

#### MCP Server Projects

**A common default**: TypeScript + the official MCP SDK for Node, or Python + the official
Python MCP SDK. Look up the SDK's current quickstart before scaffolding — the protocol and
its SDKs move quickly and the transport story in particular has changed more than once.

## Scaffold commands

#### Meta-framework + utility CSS + accessible primitives (example: Next.js)
```bash
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"
npm install <accessible-component-library>
npm install -D vitest @testing-library/react @testing-library/jest-dom @playwright/test
npx playwright install chromium
```

#### SPA bundler + React (example: Vite)
```bash
npm create vite@latest . -- --template react-ts
npm install <styling-toolchain> <accessible-component-library>
npm install -D vitest @testing-library/react @testing-library/jest-dom @playwright/test
npx playwright install chromium
```

#### Node.js + Fastify + TypeScript
```bash
npm init -y
npm install fastify @fastify/cors @fastify/helmet
npm install -D typescript @types/node tsx vitest eslint prettier
npx tsc --init --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir dist
```

#### Python + FastAPI
```bash
# Use whichever environment manager the project standardises on (uv, Poetry, PDM, or
# stdlib venv). Record the choice — CLAUDE.md must name the exact interpreter path or
# runner prefix, because a bare `pytest`/`ruff` on PATH is frequently NOT this project's.
python3 -m venv <env-dir> && <env-dir>/bin/python -m pip install --upgrade pip
<env-dir>/bin/python -m pip install fastapi "uvicorn[standard]" pydantic
<env-dir>/bin/python -m pip install pytest pytest-asyncio httpx ruff mypy
```

#### Go + Chi
```bash
go mod init github.com/<OWNER>/<PROJECT_NAME>
go get github.com/go-chi/chi/v5
go get github.com/go-chi/cors
```

#### Rust + Axum
```bash
cargo init .
cargo add axum tokio --features tokio/full
cargo add serde --features derive
cargo add tower-http --features cors
```
