---
name: e2e-test
description: Writes durable Playwright end-to-end tests for UI work. Use when asked to add e2e tests, browser tests, or Playwright specs for a PR or issue, or when a review flags missing e2e coverage. Maps acceptance criteria from the linked GitHub issue to concrete test cases, follows the Page Object Model, uses accessible locators only, and validates against real browser behaviour. Writes specs that live in the repo — use ui-vision for a one-off interactive walkthrough instead.
argument-hint: "[PR or issue number] — e.g. 'write e2e tests for PR #47' or 'e2e tests for issue #12'"
---

# E2E Test Writer

## Purpose

This skill drives the **E2E Test** agent through a structured workflow to create Playwright
end-to-end tests for UI work delivered in a pull request. Every test traces back to an
acceptance criterion in the linked GitHub issue or epic, so that user-facing behaviour is
verified in a real browser rather than asserted in a unit test that mocked the browser away.

## When to Use

- After a PR with UI changes has been implemented (typically called after the code-issue phase)
- The user asks to "write e2e tests for PR #N" or "add Playwright tests for issue #N"
- The `delivery:code-review` agent flags missing e2e coverage for UI work

## Agent

Execute with the `delivery:e2e-test` agent, which has Playwright MCP browser tools, file editing,
and shell access. GitHub work goes through the `gh` CLI, not a GitHub MCP server.

## Read the project's rules first

**The project's `CLAUDE.md` is normally already in your context; read it only if it is not (or
`AGENTS.md` when there is no `CLAUDE.md`), and obey it exactly.** That is where a
project states its own hard rules: how to start the app, which test commands are the real gate,
which paths are protected, and how test fixtures must be handled. If `.claude/delivery.md`
exists, read it too — it carries delivery-pipeline overrides for this repo.

Neither file existing is fine. Infer from the repo instead — `package.json` scripts, the
Playwright config, the compose file — and **say in your report what you inferred**, so the next
run does not have to guess the same way twice.

Nothing in this skill overrides a project rule. Where they conflict, the project wins.

## Discover the setup — do not assume it

There is no standard layout. Find the real one before writing a line of test code:

| What you need | How to find it | Do not assume |
|---|---|---|
| Test directory | `testDir` in `playwright.config.ts` | that it is `tests/` or `e2e/` |
| Base URL | `use.baseURL` in the same config | a port number; read what the config names |
| Dev-server command | `CLAUDE.md`, or the `dev` script in `package.json` | a package manager or a working directory |
| Existing patterns | read two or three existing specs and page objects | that the suite has none |
| Config location | it may sit in a sub-package, not the repo root | a single config at the root |

Read `playwright.config.ts` for `testDir` and `baseURL` and follow whatever it says. If the
project is a monorepo or keeps its UI in a sub-package, run Playwright from the directory that
owns the config — the config's own location tells you which that is.

### Playwright MCP, and what to do without it

This skill assumes the Playwright MCP server (`mcp__playwright__browser_*`) is configured. Use it
to explore the running app and confirm that a locator actually resolves before committing it to a
spec. **If the MCP server is not configured, this skill still works** — fall back to the CLI:
`npx playwright test` to run, `npx playwright codegen <url>` to discover locators interactively,
and `npx playwright show-trace` to debug a failure. Say in your report which route you used.

## Playwright Best Practices (from playwright.dev)

These rules are non-negotiable. Every test must follow them:

### Locators
- **Use user-facing locators only** — `getByRole()`, `getByLabel()`, `getByText()`, `getByPlaceholder()`, `getByTestId()`
- **Never use CSS selectors or XPath** for element identification. DOM structure changes break tests.
- **Chain and filter** to narrow scope: `page.getByRole('listitem').filter({ hasText: 'Product 2' })`

### Assertions
- **Use web-first assertions** that auto-retry: `await expect(locator).toBeVisible()`
- **Never use manual assertions**: `expect(await locator.isVisible()).toBe(true)` is wrong
- **Prefer specific assertions**: `toHaveText()`, `toHaveURL()`, `toHaveCount()`, `toContainText()`
- **Use `toMatchAriaSnapshot()`** for complex component structure verification

### Test Isolation
- **Each test must be independent** — no shared state between tests
- **Use `beforeEach`** for common setup (navigation, auth), not `beforeAll`
- **Use test fixtures** for dependency injection (page, context, browser)
- **Clean up after tests** — no leftover state in databases or UI

### Auto-waiting
- **Rely on Playwright's built-in auto-waiting** — never use `page.waitForTimeout()`
- **Use `expect().toBeVisible()` or `expect().toHaveText()`** instead of sleep-based waits
- Playwright auto-waits for elements to be actionable before interacting

### Page Object Model
- **Every UI page/section gets a Page Object class**, in whatever directory the existing suite
  keeps them (commonly a `pages/` folder beside the specs)
- Page Objects encapsulate selectors and common interactions
- Tests read like user stories, not DOM manipulation scripts
- Page Object methods return `this` or another Page Object for chaining

### Test Organization
- **File naming**: `<feature-or-page>.spec.ts`, inside the config's `testDir`
- **Group with `test.describe()`** — one describe block per feature
- **Use `test.step()`** for multi-step interactions within a test
- **Descriptive titles**: `test('should display error when submitting empty form')`

## Four failure modes that survive every test you would naturally write

These are the traps that make a green suite meaningless. Read them before Step 2, because they
change which tests you decide to write.

### 1. Canvas- and WebGL-rendered UI is invisible to the accessibility tree

A map, chart, diagram editor, or any other `<canvas>` surface renders pixels. It publishes no
roles, no labels, no text. **You cannot assert on it with a role locator**, and a test that tries
either fails forever or — worse — passes by matching some unrelated element.

Assert against two things instead:

- **The surrounding controls** — the legend, the layer list, the zoom buttons, the readout that
  reports the selected feature. Those are real DOM, and they are what the user actually operates.
- **An explicit render guard the app exposes** — an attribute, a test id, or an event the app
  sets once a frame has genuinely drawn.

**Follow whatever guard pattern the existing suite already uses.** If the app exposes a
render-complete signal, use it; do not invent a second one. If it exposes none, the right change
is usually a one-line addition to the app that publishes the signal — propose that rather than
reaching for pixel comparison or a timeout.

### 2. A control that flips state nothing renders from is a no-op that still passes tests

A filter checkbox that writes to a store no component reads from will toggle, persist, and
satisfy every assertion you would naturally write about the checkbox. The feature is broken and
the test is green.

So when validating a filter, toggle, sort, or search control: **capture the rendered output
before AND after, and assert that what is drawn changed** — the visible row count, the list
contents, the legend, a screenshot of the canvas region. Asserting that the checkbox became
checked proves only that the checkbox works.

### 3. A green build can ship a blank screen

A build that type-checks and bundles successfully proves nothing about what loads in a browser. A
required runtime asset missing from the output — a worker script, a wasm module, a lazily fetched
chunk — produces a clean build and a blank page. That is exactly the class of bug e2e exists for:
at least one test must load the real app at the real URL and assert that primary content
rendered. Check the browser console during that test too; a silent 404 for a runtime asset shows
up there first.

### 4. A disabled control cannot be clicked, so "clicking it does nothing" can never fail

If the app renders a control `disabled`, a test that clicks it and asserts nothing happened is
vacuous — Playwright's actionability check means the click never lands, so the assertion is
guaranteed. Assert the *state* instead: `await expect(button).toBeDisabled()`, plus a separate
test that it becomes enabled under the condition that should enable it.

## Workflow Overview

```
┌─────────────────────────────────────────────────────────┐
│  1. ORIENT — Read PR, linked issues, acceptance criteria│
├─────────────────────────────────────────────────────────┤
│  2. MAP — Map acceptance criteria → test cases          │
├─────────────────────────────────────────────────────────┤
│  3. SCAFFOLD — Create page objects and test structure   │
├─────────────────────────────────────────────────────────┤
│  4. IMPLEMENT — Write tests for each acceptance criterion│
├─────────────────────────────────────────────────────────┤
│  5. VALIDATE — Run tests, fix failures, verify coverage │
├─────────────────────────────────────────────────────────┤
│  6. DELIVER — Commit, push, report results              │
└─────────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: Orient

1. **Read the PR** — `gh pr view <number> --json title,body,files`, and `gh pr diff <number>`
   - List all changed files, identify UI-related changes
   - Read the PR description for context
2. **Read linked issues** — `gh issue view <number>`
   - Extract every acceptance criterion from the issue body
   - Note any edge cases or error scenarios mentioned
3. **Read the UI code** — understand the component tree, routes, and interactions. Note anything
   rendered to a canvas or WebGL surface; that changes how you will assert on it.
4. **Check for existing tests** in the config's `testDir`, and read the page objects already
   there — matching their conventions matters more than matching this document.
5. **Read `playwright.config.ts`** — `testDir`, `baseURL`, `webServer`, projects. If no config
   exists, plan to create one.

### Step 2: Map Acceptance Criteria to Test Cases

Create an explicit mapping table. Every acceptance criterion must have at least one test:

| # | Acceptance Criterion (from issue) | Test Case | Priority |
|---|-----------------------------------|-----------|----------|
| 1 | User can log in with valid creds  | `auth.spec.ts: should log in successfully` | P0 |
| 2 | Error shown for invalid password  | `auth.spec.ts: should show error for wrong password` | P0 |
| 3 | Session persists on refresh       | `auth.spec.ts: should maintain session after reload` | P1 |

Rules:
- **Every P0 criterion gets a test** — no exceptions
- **Happy path + error path** for each user flow
- **Visual state changes** (loading, empty, error states) get dedicated tests
- **Any criterion about a filter or toggle** gets a before/after assertion on rendered output,
  never on the control's own state alone
- **Flag unmapped criteria** — report any acceptance criteria that cannot be tested via e2e

### Step 3: Scaffold

#### Playwright Config (only if the project has none)

If a config already exists, **do not rewrite it** — read it and conform. Adding a second config to
a project that already has one is how a suite ends up with two `testDir`s and half its tests
silently unrun. A minimal starting config looks like:

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['html', { open: 'never' }]],
  use: {
    // Point this at the project's own dev-server URL rather than hardcoding a guess.
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

**A warning about `webServer.reuseExistingServer`.** When it is true — the usual non-CI default —
Playwright does not verify *what* is listening on the port, only that something is. If another
checkout of the same app, or a stale server from an earlier session, already holds it, your tests
run against that code and your changes appear to have no effect. The failures make no sense, and
neither do the passes. If results contradict the diff you just wrote, find out what is actually
serving the port before you debug the test.

#### Page Object Template

```typescript
// <testDir>/pages/<page-name>.page.ts
import type { Page, Locator } from '@playwright/test';

export class ExamplePage {
  readonly page: Page;
  readonly heading: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.heading = page.getByRole('heading', { name: 'Example' });
    this.submitButton = page.getByRole('button', { name: 'Submit' });
  }

  async goto() {
    await this.page.goto('/example');
  }

  async submit() {
    await this.submitButton.click();
  }
}
```

#### Directory Structure

Mirror whatever the project already does. A typical shape:

```
<testDir>/
├── pages/           # Page Object Models
│   ├── admin.page.ts
│   ├── dashboard.page.ts
│   └── ...
├── admin.spec.ts    # Test specs — one per feature/page
├── dashboard.spec.ts
└── ...
playwright.config.ts
```

### Step 4: Implement Tests

For each test case from the mapping table:

1. **Create or update the Page Object** for the relevant page
2. **Write the test** using the POM, following all best practices above
3. **Include `test.step()`** for complex multi-step flows
4. **Add the acceptance criterion reference** as a comment:

```typescript
test.describe('Admin Settings Panel', () => {
  test.beforeEach(async ({ page }) => {
    const adminPage = new AdminPage(page);
    await adminPage.goto();
  });

  // AC: "All configurable settings are visible in the admin panel"
  test('should display all known settings', async ({ page }) => {
    await test.step('Navigate to the settings section', async () => {
      await page.getByRole('link', { name: 'Settings' }).click();
    });

    await test.step('Verify known settings are listed', async () => {
      await expect(page.getByRole('row', { name: /Retention period/ })).toBeVisible();
      await expect(page.getByRole('row', { name: /Default timezone/ })).toBeVisible();
    });
  });

  // AC: "Filtering by status hides non-matching rows"
  // Note: assert on what is RENDERED, not on the control's own state.
  test('should filter the list when a status is selected', async ({ page }) => {
    const rows = page.getByRole('row');
    const before = await rows.count();

    await page.getByLabel('Status').selectOption('Archived');

    await expect(rows).not.toHaveCount(before);
    await expect(page.getByRole('row', { name: /Active/ })).toHaveCount(0);
  });
});
```

### Step 5: Validate

1. **Start the app if the config does not** — use the project's own dev-server command;
   `CLAUDE.md` names it, or read the `dev` script. If the config has a `webServer` block,
   Playwright starts it for you; confirm nothing stale already owns the port.
2. **Run tests** — `npx playwright test --project=chromium`, from the directory owning the config
3. **Fix failures** — debug using traces: `npx playwright test --trace on`, then
   `npx playwright show-trace`
4. **Confirm the tests can actually fail** — for any assertion you are unsure of, break the
   expectation once and check that the test goes red. A test that cannot fail is not coverage.
5. **Verify mapping coverage** — every P0 acceptance criterion has a passing test
6. **Run in CI mode** — `CI=true npx playwright test` to simulate pipeline behaviour

### Step 6: Deliver

1. **Commit** with a conventional message: `test(e2e): add Playwright tests for #{issue-number}`
2. **Push** to the existing feature branch — never to the default branch
3. **Report results** to the caller:

```
## E2E Test Results

### Acceptance Criteria Coverage
| # | Criterion | Test | Status |
|---|-----------|------|--------|
| 1 | ... | `admin.spec.ts:L12` | Pass |
| 2 | ... | `admin.spec.ts:L28` | Pass |

### Test Summary
- Total: {N} tests
- Passed: {N}
- Failed: {N}
- Skipped: {N}

### What I inferred
{Test dir, baseURL, dev-server command — and where each came from: config, CLAUDE.md, or a guess}

### Unmapped Criteria
{List any acceptance criteria that could not be covered by e2e tests, with explanation}
```

## Anti-Patterns to Avoid

| Anti-Pattern | Why It's Bad | Do This Instead |
|-------------|-------------|-----------------|
| `page.waitForTimeout(1000)` | Flaky, slow | Use web-first assertions |
| `page.locator('.btn-primary')` | Breaks on CSS changes | `page.getByRole('button', {name: '...'})` |
| `expect(await el.isVisible()).toBe(true)` | No auto-retry | `await expect(el).toBeVisible()` |
| Tests sharing state via `beforeAll` | Non-isolated, flaky | `beforeEach` with clean setup |
| Role locators against a canvas | Canvas publishes no roles — matches nothing, or the wrong thing | Assert on surrounding controls plus the app's render guard |
| Asserting only that a toggle is checked | Passes even when nothing renders from it | Assert the rendered output changed |
| Clicking a `disabled` control to prove inaction | The click never lands; the test cannot fail | `await expect(el).toBeDisabled()` |
| Testing implementation details | Brittle | Test user-visible behaviour |
| Huge monolithic test files | Hard to maintain | One file per feature/page |
| Skipping error/edge-case paths | False confidence | Test unhappy paths too |
| No Page Objects | Duplicated selectors | Always use POM pattern |

## Shell Execution Rules

**Follow the same shell hygiene rules as the `delivery:code-issue` skill:**

1. Batch commands with `&&`
2. No watch mode — use `npx playwright test`, which exits cleanly; never `--ui`
3. No background processes left running when you finish
4. No interactive sessions

## Prerequisites

- `@playwright/test` installed in the project
- Playwright browsers installed: `npx playwright install chromium`
- Application reachable at the config's `baseURL` — either already running, or started by a
  `webServer` block in `playwright.config.ts`
- `gh` CLI authenticated, for reading PRs and issues
- Playwright MCP browser tools, optionally — used to explore the live app and confirm locators;
  `npx playwright codegen` covers the same ground without them
