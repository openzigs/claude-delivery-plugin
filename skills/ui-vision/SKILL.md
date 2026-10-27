---
name: ui-vision
description: Drives a real headed Chrome browser through a running web app to validate UI behaviour visually. Use when asked to walk through, click through, visually test, or QA a page or flow in a browser, or to reproduce a UI bug live. Collects findings with screenshots, console errors, and network failures, then files them and hands off to code-issue for batch fixes. Requires the app to be running and writes no tests — use e2e-test for durable Playwright specs.
argument-hint: "Describe the walkthrough scenario — e.g. 'walk through the layer controls' or 'test the settings page against the local dev server'"
---

# UI Vision — Interactive Browser Walkthrough

## Purpose

This skill drives the **UI Vision** agent through a structured walkthrough of a web application
in a real Chrome browser. It navigates pages, interacts with elements, takes screenshots at
every step, validates expected behaviour, and documents bugs with full evidence. After the
walkthrough it hands any discovered bugs to the `delivery:code-issue` agent for batch fixing,
then re-tests to verify the fixes.

It writes no tests. Anything worth keeping should become a Playwright spec via
`/delivery:e2e-test` afterwards.

## When to Use

- The user asks to "walk through" or "test" a page, feature, or workflow in the browser
- A caller runs UI Vision as an optional phase after implementation (the user must explicitly
  request it — it is never automatic)
- The user wants to visually verify that a deployed feature works as expected
- The user says "check the UI", "look at the admin page", "test the setup wizard", or similar

## Agent

Execute with the `delivery:ui-vision` agent, which has Playwright MCP (real headed Chrome) and
shell access. GitHub work goes through the `gh` CLI, not a GitHub MCP server.

## Read the project's rules first

**The project's `CLAUDE.md` is normally already in your context; read it only if it is not (or
`AGENTS.md` when there is no `CLAUDE.md`), and obey it exactly.** That is where a
project states its own hard rules: how to start the app, which commands are the real gate, which
paths are protected, and how sensitive material must be handled. A walkthrough puts whatever is
on screen into screenshots and into the transcript, so data-handling rules matter more here than
almost anywhere else — if the project restricts what may be read or displayed, that restriction
covers what you point a browser at. If `.claude/delivery.md` exists, read it too.

Neither file existing is fine. Infer from the repo instead — `package.json` scripts, the
Playwright config, the compose file — and **say in your report what you inferred**.

## Playwright MCP is required

This skill drives the browser through the Playwright MCP server (`mcp__playwright__browser_*`).
There is no fallback: a scripted headless run is a different activity with a different output,
and it is not this skill.

**If the MCP server is not configured, stop and say so.** Tell the user the walkthrough cannot
run without it, and offer the two real alternatives: configure the Playwright MCP server, or run
`/delivery:e2e-test` to write durable specs instead. Never simulate a walkthrough from reading
the source and report it as though a browser had been driven.

## Prerequisites

Before starting, establish each of these. Nothing here has a safe default:

| Requirement | How to get it |
|-------------|---------------|
| Target URL | The user provides it, or take it from the project's dev-server config — `CLAUDE.md` names the command and URL, or read the `dev` script and the Playwright config's `baseURL`. Do not assume a port. |
| App running | Start it with the project's own command, or confirm something is already serving the URL. If it is down, say so and stop. |
| API reachable | Check the backend the UI depends on before walking anything — see below. |
| Scenario description | The user must describe what to walk through. |
| Credentials / test data | Ask the user if the scenario needs a login or specific input. |

**If any required input is missing, pause and ask the user. Do not proceed on assumptions.**

### An unreachable backend is one finding, not fifteen

A UI whose API is down renders empty lists, blank panels, zero counts, and disabled buttons —
all of which look exactly like bugs, and none of which are. Walking the whole scenario in that
state produces a report full of fiction that costs someone an afternoon.

So before the walkthrough, confirm the API actually answers: hit its health endpoint or one real
endpoint with `curl`, or navigate once and check `browser_network_requests` for a wall of failed
calls. If the backend is unreachable, **file that as the single finding and stop**. Say plainly
that the UI could not be evaluated because its API was down.

### A green build can still ship a blank screen

If the page loads to nothing at all, do not assume you have the wrong URL. A required runtime
asset missing from the bundle — a worker script, a wasm module, a lazily fetched chunk — yields a
build that compiles cleanly and a page that renders nothing. Check `browser_console_messages`
and `browser_network_requests` for a 404 on an asset before concluding anything else. It is a
real bug class, and a high-severity one.

## Workflow Overview

```
┌─────────────────────────────────────────────────────────────┐
│  1. PREPARE — Confirm URL, scenario, prerequisites          │
├─────────────────────────────────────────────────────────────┤
│  2. LAUNCH — Open browser, screenshot initial state          │
├─────────────────────────────────────────────────────────────┤
│  3. WALK — Step-by-step execution:                           │
│     For each step in the scenario:                           │
│       a. Describe the action about to be taken               │
│       b. Snapshot to get fresh element refs                  │
│       c. Execute the action (click, type, navigate)          │
│       d. Wait for the page to settle                         │
│       e. Screenshot the result                               │
│       f. Read page content to validate expected state        │
│       g. Check console and network for errors                │
│       h. If behaviour is wrong → log a bug with evidence     │
├─────────────────────────────────────────────────────────────┤
│  4. REPORT — Summarize walkthrough results                   │
├─────────────────────────────────────────────────────────────┤
│  5. HANDOFF — File issues, call code-issue for fixes         │
├─────────────────────────────────────────────────────────────┤
│  6. RE-TEST — Re-run failing steps after fixes are pushed    │
└─────────────────────────────────────────────────────────────┘
```

## Detailed Steps

### Step 1: PREPARE

1. Parse the user's request to extract:
   - **Target URL** — the URL they give you, or the one the project's config names
   - **Scenario** — which pages, features, or flows to walk through
   - **Parameters** — any test data, credentials, or configuration values the user supplied
2. If the scenario needs information the user did not provide (login credentials for a protected
   page, specific values to enter in a form), **stop and ask**. Present your questions clearly:
   ```
   Before I start the walkthrough, I need a few things:
   1. What credentials should I use to log in?
   2. Should I use any specific test data for the form fields?
   ```
3. Verify the target app is reachable with `browser_navigate`, and verify its API is reachable
   as described above. If either is down, report it and stop.

### Step 2: LAUNCH

1. Navigate to the target URL using `browser_navigate`
2. Take an initial screenshot with `browser_take_screenshot`
3. Get an accessibility snapshot with `browser_snapshot` to establish element refs and baseline
   state
4. Check `browser_console_messages` for pre-existing errors, and `browser_network_requests` for
   failed calls — both are part of the baseline, and both are findings if present
5. Note the initial state in your walkthrough log:
   ```
   ## Walkthrough: {scenario description}
   - **URL**: {target URL}
   - **Started**: {timestamp}
   - **Initial state**: {brief description of what the page shows}
   ```

### Step 3: WALK

For each step in the scenario, follow this cycle:

#### 3a. Describe
Before executing, state what you are about to do:
> "Step 3: Clicking the 'Save Settings' button to submit the form"

#### 3b. Snapshot
**Always call `browser_snapshot` first** to get the current accessibility tree with `ref`
attributes. Use those refs to target elements. Never reuse a ref from an earlier snapshot — the
page state may have changed, and a stale ref fails in a way that reads like a broken app.

#### 3c. Execute
Use the appropriate Playwright MCP tool with the `ref` from the snapshot:
- `browser_click` — buttons, links, tabs, checkboxes, radio buttons (pass `ref`)
- `browser_type` — text fields, search boxes, text areas (pass `ref` and text)
- `browser_navigate` — URL navigation
- `browser_hover` — hover-triggered menus, tooltips (pass `ref`)
- `browser_select_option` — dropdown selections (pass `ref` and value)
- `browser_press_key` — keyboard input (Enter, Tab, Escape)
- `browser_handle_dialog` — browser dialogs (alert, confirm, prompt)

#### 3d. Wait
Let the page settle after the action. Playwright auto-waits for most interactions, but for
API-triggered updates:
- Call `browser_snapshot` again to check whether content has updated
- Use `browser_network_requests` to verify the API calls completed

#### 3e. Screenshot
**Always** take a screenshot with `browser_take_screenshot` after each significant action:
- Page navigation
- Form submission
- Modal or dialog open and close
- Tab or section switch
- Error state appearance
- Success confirmation

#### 3f. Validate
Check that the result matches expectations:
- Use `browser_snapshot` to extract the accessibility tree and text content
- Compare against the expected behaviour from the scenario
- Check for:
  - Correct page title and heading
  - Expected content visible
  - Form values persisted
  - Success or error messages displayed
  - Navigation to the correct URL
  - No layout breakage

**Two validation traps that will otherwise make you report "works" for something broken:**

- **Canvas- and WebGL-rendered UI does not appear in the accessibility tree.** A map, chart, or
  diagram surface publishes no roles, labels, or text, so `browser_snapshot` shows you an empty
  box no matter what is drawn. Validate it through the surrounding controls — legend, layer
  list, selection readout, zoom buttons — plus whatever render-complete signal the app exposes,
  and by comparing screenshots. Never conclude "the canvas is empty" from a snapshot alone.
- **A control that flips state nothing renders from is a no-op that still looks correct.** A
  filter or toggle can update itself perfectly while the view behind it never changes. So when
  you exercise a filter, sort, or toggle, **screenshot before AND after, and verify that what is
  drawn changed** — not merely that the checkbox is now checked. If the drawn output is
  identical, that is the bug, and it is one you will only catch by looking.

#### 3g. Console and network check
After each significant action, check `browser_console_messages` for:
- JavaScript errors (`Error`, `TypeError`, `ReferenceError`)
- Unhandled promise rejections
- Failed asset loads (a 404 on a script, worker, or module is high severity)

And `browser_network_requests` for 4xx and 5xx responses. Note deprecation warnings, but do not
file them as bugs.

#### 3h. Bug logging
If any validation fails or unexpected behaviour occurs, log a bug:

```
### Bug #{n}: {short descriptive title}
- **URL**: {current page URL}
- **Step**: {the action that triggered or revealed the bug}
- **Expected**: {what should have happened}
- **Actual**: {what actually happened}
- **Screenshot**: {reference to the screenshot taken}
- **Console errors**: {any JS errors captured, or "None"}
- **Network errors**: {any failed API calls, or "None"}
- **Severity**: critical | high | medium | low | nit
  - Critical: app crash, data loss, security issue
  - High: feature broken, blocking workflow
  - Medium: wrong behaviour but a workaround exists
  - Low: cosmetic issue, minor UX problem
```

Before filing, sanity-check the finding against these two:

- **A control rendered `disabled` cannot be clicked.** If a button does nothing, check whether it
  is disabled before reporting "the button is broken" — the finding is then "the button is
  disabled when it should be enabled", which is a different bug with a different fix.
- **Related empty states usually share one cause.** Three blank panels fed by the same endpoint
  are one finding, not three.

**Do not stop the walkthrough when a bug is found.** Document it and continue.

#### 3i. Continue
Move to the next step in the scenario. If a bug blocks further progress on the current path,
note it and try an alternative path if one exists, or skip ahead.

### Step 4: REPORT

After completing all steps (or exhausting the scenario), present a structured report:

```
## Walkthrough Report

### Summary
- **URL**: {target URL}
- **Scenario**: {what was tested}
- **Steps completed**: {N}/{total}
- **Bugs found**: {count by severity}
- **Overall status**: PASS | FAIL | PARTIAL

### Steps Executed
| # | Action | Result | Bug? |
|---|--------|--------|------|
| 1 | Navigated to /admin | Page loaded correctly | No |
| 2 | Clicked "Settings" tab | Tab switched, form displayed | No |
| 3 | Submitted form with empty fields | No validation error shown | Bug #1 |
| ... | ... | ... | ... |

### Bugs Found
{Include full bug documentation from Step 3h for each bug}

### Console Health
- JS errors observed: {count}
- Failed network requests: {count}
- Details: {list if any}

### What I inferred
{Target URL, how the app was started, and where each came from — CLAUDE.md, config, or a guess}
```

### Step 5: HANDOFF (conditional — only if bugs were found)

If bugs were found during the walkthrough:

1. **File GitHub issues** with the `gh` CLI:
   - One issue per bug, or group tightly related bugs into a single issue
   - Include the bug documentation, reproduction steps, and severity
   - **Put the body in a file and pass it with `--body-file`.** A bug report with reproduction
     steps and code blocks is far too long and too full of shell-hostile characters to survive
     `--body "..."`:
     ```bash
     gh issue create \
       --title "Settings form accepts empty submission without validation" \
       --body-file /tmp/bug-1.md \
       --label bug
     ```
   - Confirm a label exists before using it; `gh` fails the whole command on an unknown label.
     `gh label list` tells you what the repo has.
2. **Call the `delivery:code-issue` agent** to fix the bugs:
   - Pass the bug issues as a batch, with reproduction steps and expected behaviour
   - That agent will create a feature branch, fix the bugs test-first, run the project's gates,
     and open a PR
   - Wait for it to report back with the PR number
3. **If called by another agent**, report the issue numbers and the PR number back rather than
   proceeding. The caller routes through its own Review → Fix → Re-Review cycle before calling
   back for re-testing.

### Step 6: RE-TEST (conditional — only after fixes are pushed)

After the fixes are pushed:

1. **Make sure you are looking at the new code.** Restart or reload the dev server if it does not
   hot-reload, and confirm the running app is the fixed build — a browser cache or a server still
   holding the old bundle will show you the old bug and send everyone back around the loop.
2. Navigate back to the target URL using `browser_navigate`
3. Re-execute **only the steps that had bugs**, not the entire walkthrough
4. For each previously failing step:
   - Call `browser_snapshot` for fresh element refs
   - Execute the same action
   - `browser_take_screenshot` the result
   - Validate that the fix resolves the reported issue
5. Report re-test results:
   ```
   ### Re-Test Results
   | Bug # | Title | Fixed? | Notes |
   |-------|-------|--------|-------|
   | 1 | Form validation missing | Yes | Error messages now display |
   | 2 | Save button unresponsive | No | Still fails on double-click |
   ```
6. If any bugs persist, report back to the caller for another fix cycle or manual intervention

## Standalone vs Delegated Mode

### Standalone Mode
When the user invokes UI Vision directly:
- Run the full workflow (Prepare → Launch → Walk → Report → Handoff → Re-Test)
- Manage the entire lifecycle, including the `delivery:code-issue` handoff
- Report directly to the user at each stage

### Delegated Mode
When another agent invokes UI Vision as a phase of a larger pipeline:
- The caller provides the PR number, branch name, target URL, and scenario
- Run Prepare → Launch → Walk → Report
- If bugs are found, report them back with issue numbers; do not start a fix cycle yourself
- The caller routes through code-issue → review → re-review, then calls UI Vision again
- On re-test, verify only the previously failing steps

## Tips for Effective Walkthroughs

- **Be methodical** — go through forms field by field, not all at once
- **Test edge cases** — empty submissions, very long input, special characters
- **Check responsive behaviour** — use `browser_resize` and note whether the layout breaks
- **Verify persistence** — after saving, navigate away and come back to confirm it stuck
- **Test error states** — deliberately trigger errors to verify error handling
- **Check accessibility** — note interactive elements lacking labels or focus indicators (Low
  severity, but real, and cheap to spot from a snapshot you already took)
- **Snapshot before every interaction** — always call `browser_snapshot` for fresh `ref`
  attributes; stale refs fail in ways that impersonate application bugs
- **Console and network after every API call** — `browser_console_messages` and
  `browser_network_requests` after form submissions catch silent failures the UI never shows
- **Screenshot before and after anything that filters or toggles** — comparing the two is the
  only way to tell a working control from one nothing renders from
- **Leave the browser closed** — call `browser_close` when the walkthrough is done
