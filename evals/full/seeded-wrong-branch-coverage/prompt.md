Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/coupons.js b/src/coupons.js
--- a/src/coupons.js
+++ b/src/coupons.js
@@ -1,3 +1,4 @@
 export function applyCoupon(total, coupon) {
+  if (coupon.expiresAt < Date.now()) throw new Error('coupon expired')
   return Math.max(0, total - coupon.amount)
 }
diff --git a/test/coupons.test.js b/test/coupons.test.js
--- a/test/coupons.test.js
+++ b/test/coupons.test.js
@@ -1,5 +1,9 @@
 import { applyCoupon } from '../src/coupons'
 
 test('applyCoupon never goes below zero', () => {
-  expect(applyCoupon(10, { amount: 30 })).toBe(0)
+  expect(applyCoupon(10, { amount: 30, expiresAt: Date.now() + 60000 })).toBe(0)
+})
+
+test('applyCoupon subtracts the coupon amount', () => {
+  expect(applyCoupon(100, { amount: 30, expiresAt: Date.now() + 60000 })).toBe(70)
 })
```
