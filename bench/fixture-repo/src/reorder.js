import { lowStock } from './inventory.js'

// The nightly reorder: one CSV line `SKU,qty` per SKU under the threshold, ordering enough to
// bring it back up to the threshold. The warehouse system emails the lines to the supplier as
// they are.
export function reorderLines(stock, threshold) {
  return lowStock(stock, threshold).map((sku) => `${sku},${threshold - stock[sku]}`)
}
