import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addItem, totalUnits, lowStock } from '../src/inventory.js'

test('addItem adds to an existing SKU and creates a new one', () => {
  assert.deepEqual(addItem({ a: 2 }, 'a', 3), { a: 5 })
  assert.deepEqual(addItem({}, 'b', 1), { b: 1 })
})

test('addItem does not mutate its input', () => {
  const stock = { a: 1 }
  addItem(stock, 'a', 1)
  assert.deepEqual(stock, { a: 1 })
})

test('addItem rejects a non-positive or fractional quantity', () => {
  assert.throws(() => addItem({}, 'a', 0), RangeError)
  assert.throws(() => addItem({}, 'a', 1.5), RangeError)
})

test('totalUnits sums every SKU', () => {
  assert.equal(totalUnits({ a: 2, b: 3 }), 5)
  assert.equal(totalUnits({}), 0)
})

test('lowStock lists SKUs under the threshold, sorted', () => {
  assert.deepEqual(lowStock({ c: 1, a: 0, b: 9 }, 2), ['a', 'c'])
})
