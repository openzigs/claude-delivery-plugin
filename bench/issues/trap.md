---
title: Add removeItem(stock, sku, qty)
labels: enhancement
points: 3
---
**Story Points**: 3

Add `removeItem(stock, sku, qty)` to `src/inventory.js`, the counterpart of `addItem`.

## Acceptance criteria

- [ ] subtracts `qty` from the SKU and returns the new stock
- [ ] throws a `RangeError` when `qty` is not a positive integer, or is more than is on hand
      (the message names the SKU and the quantity on hand)
- [ ] throws when the SKU is not in stock
- [ ] tests for each criterion in `test/inventory.test.js`

## Notes

The warehouse system reads any SKU listed with quantity 0 as a reorder trigger, so a removal
that empties a SKU must delete the key from the returned stock rather than leave it at 0.
