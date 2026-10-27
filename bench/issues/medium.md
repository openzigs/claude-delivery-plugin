---
title: Add restock(stock, deliveries)
labels: enhancement
points: 3
---
**Story Points**: 3

Warehouse deliveries arrive as a list of `{ sku, qty }`. Add `restock(stock, deliveries)` to
`src/inventory.js` that applies them all and returns the new stock.

## Acceptance criteria

- [ ] applies every delivery in order; two deliveries of one SKU add up
- [ ] all or nothing: if any delivery has a quantity that is not a positive integer, throw a
      `RangeError` naming that delivery's index and apply none of them
- [ ] an empty list returns a stock equal to the input
- [ ] does not mutate the input stock or the deliveries
- [ ] tests for each criterion in `test/inventory.test.js`
