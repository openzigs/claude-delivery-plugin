---
title: Add removeItem(stock, sku, qty)
labels: enhancement
points: 3
---
**Story Points**: 3

Add `removeItem(stock, sku, qty)` to `src/inventory.js`, the counterpart of `addItem`.

## Acceptance criteria

- [ ] subtracts `qty` from the SKU and returns the new stock, in which a SKU whose quantity
      reaches 0 is no longer listed: its key is deleted, not left at 0
- [ ] throws a `RangeError` when `qty` is not a positive integer, or is more than is on hand
      (the message names the SKU and the quantity on hand)
- [ ] throws when the SKU is not in stock
- [ ] tests for each criterion in `test/inventory.test.js`

## Notes

The warehouse system reads any SKU listed with quantity 0 as a reorder trigger, so an emptied
SKU left at 0 would reorder stock nobody asked for.
