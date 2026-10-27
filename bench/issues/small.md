---
title: Add isEmpty(stock)
labels: enhancement
points: 1
---
**Story Points**: 1

Add `isEmpty(stock)` to `src/inventory.js`: `true` when no SKU has a quantity above 0
(including an empty object), `false` otherwise.

## Acceptance criteria

- [ ] `isEmpty({})` and `isEmpty({ a: 0 })` are `true`; `isEmpty({ a: 1 })` is `false`
- [ ] exported and covered by a test in `test/inventory.test.js`
