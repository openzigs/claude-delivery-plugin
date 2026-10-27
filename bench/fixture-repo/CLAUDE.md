# bench-fixture-inventory

A tiny inventory module used to benchmark the delivery plugin. No dependencies.

- Test: `npm test` (node's built-in runner). CI runs exactly this on every pull request.
- Coverage: no tool; every exported function needs a test that fails without it.
- Changelog: none.
- Stock objects are shared with the audit log: no function may mutate the stock it is given.
