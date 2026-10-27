---
title: lowStock returns the quantity on hand with each SKU
labels: enhancement
points: 3
defect: For maintainers only; front matter is never filed. The natural change returns objects from lowStock and passes the suite, but the unchanged src/reorder.js still reads each entry as a SKU string, so the nightly reorder emails "[object Object],NaN" lines. Its one test uses a stock with nothing low, so npm test stays green. A reviewer checking the callers of a changed function finds it.
defectLocations: src/reorder.js
defectKeywords: reorderLines, reorder.js
---
**Story Points**: 3

The restock screen lists the low SKUs with the quantity on hand next to each, and looks every
quantity up again to do it. Change `lowStock(stock, threshold)` in `src/inventory.js` to return
the quantity with each SKU.

## Acceptance criteria

- [ ] `lowStock(stock, threshold)` returns `[{ sku, qty }]`, one entry for every SKU whose
      quantity is below `threshold`, sorted by SKU
- [ ] an empty stock returns `[]`
- [ ] tests for each criterion in `test/inventory.test.js`, replacing the old assertion on a
      list of SKU strings
