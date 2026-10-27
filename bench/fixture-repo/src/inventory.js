// Stock is a plain object of SKU -> quantity on hand. Every function returns a new object
// and never mutates the one it was given: callers share stock objects with the audit log.

export function addItem(stock, sku, qty) {
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError(`qty must be a positive integer, got ${qty}`)
  return { ...stock, [sku]: (stock[sku] ?? 0) + qty }
}

export function totalUnits(stock) {
  return Object.values(stock).reduce((n, q) => n + q, 0)
}

export function lowStock(stock, threshold) {
  return Object.keys(stock).filter((sku) => stock[sku] < threshold).sort()
}
