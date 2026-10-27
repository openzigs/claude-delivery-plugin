# Shell Execution Rules (shared)

The full shell rules for the code-issue and code-review procedures. Each skill keeps a digest
inline under `## Shell Execution Rules` and points here.

**Critical — follow these to avoid orphaned terminals and hung sessions:**

1. **Batch commands** — chain multiple commands in a SINGLE shell call using `&&`, so a failure stops
   the chain. The one exception is the read-only orient batch (your procedure's Step 1), joined with `;` on
   purpose so a missing file does not abort the rest. Never open a new shell invocation per command.
   ```bash
   # CORRECT — one call
   npm run lint && npm run test && npm run build

   # WRONG — three separate calls
   npm run lint
   npm run test
   npm run build
   ```

2. **No watch mode** — never run watch or interactive commands. Always force one-shot execution.
   Test runners default to watch mode in several ecosystems; use the run-once form (`--run`,
   `--watch=false`, `CI=1`; the exact flag depends on the runner) and check what the project's
   script actually does before trusting it.
   **The only exception** is the bounded `gh pr checks` CI wait your procedure describes: streamed output
   discarded, an explicit Bash `timeout` of at most `600000` ms, then one compact JSON read.

3. **No background processes** — never use `&`, `nohup` or `disown`. Dev servers and hot-reloading
   application servers are long-running and never belong in a gate.

4. **No interactive sessions** — never launch a REPL (`node`, `python`, `psql`, `sqlite3` without
   `-c`). Use the one-shot flag form.

5. **CI quality gate** — run the project's gate as one batched call per toolchain. A repository with
   two toolchains is two calls; run only the side(s) your change touches, and both if it touches
   both. `CLAUDE.md` names the real commands. The table below is the *shape*, not the commands:

   | Ecosystem | Batched gate (example only) |
   |---|---|
   | Node | `npm run lint && npm run test && npm run build` |
   | Python | `python -m pytest -q && python -m ruff check <changed files> && python -m mypy <changed files>` |
   | Go | `go vet ./... && go test ./... && go build ./...` |
   | Rust | `cargo clippy -- -D warnings && cargo test && cargo build` |

   Two details worth establishing once per repository, because both bite silently: a build script
   may also *be* the typecheck (the type checker chained ahead of the bundler), so skipping the
   build skips type checking entirely; and a project virtual environment may need its interpreter
   invoked explicitly as `<env>/bin/python -m <tool>` rather than the tool's console script, because
   a bare tool name can resolve to a system install that lacks the project's dependencies and fails
   in a way that reads like the tool is missing.

6. **Keep command output small.** Every line a command prints stays in your context and is re-sent
   on every later turn, so one noisy test run can cost more than the rest of the task put
   together. Run tests with a quiet or summary reporter (`--reporter=dot`, `-q`, `--silent`,
   `--quiet`), and pipe long output through `tail -n 60` or a `grep` for failures — then re-run only
   the failing test, verbosely, if you need its detail. Never print a whole build log, coverage
   table or lockfile diff to read one line of it.
