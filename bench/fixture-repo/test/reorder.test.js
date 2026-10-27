import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reorderLines } from '../src/reorder.js'

test('reorderLines orders nothing when every SKU is at or above the threshold', () => {
  assert.deepEqual(reorderLines({ a: 5, b: 2 }, 2), [])
})
