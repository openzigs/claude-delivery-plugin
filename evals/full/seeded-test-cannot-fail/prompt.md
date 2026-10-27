Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/billing.js b/src/billing.js
--- a/src/billing.js
+++ b/src/billing.js
@@ -1,3 +1,7 @@
 export function orderTotal(order) {
   return order.lines.reduce((n, l) => n + l.price * l.qty, 0)
 }
+
+export async function chargeOrder(order, gateway) {
+  return gateway.charge({ customerId: order.customerId, amount: orderTotal(order) })
+}
diff --git a/test/billing.test.js b/test/billing.test.js
--- a/test/billing.test.js
+++ b/test/billing.test.js
@@ -1,8 +1,15 @@
-import { orderTotal } from '../src/billing'
+import { orderTotal, chargeOrder } from '../src/billing'
 
 test('orderTotal sums price x qty', () => {
   expect(orderTotal({ lines: [{ price: 5, qty: 2 }, { price: 1, qty: 3 }] })).toBe(13)
 })
+
+test('chargeOrder charges the customer the order total', async () => {
+  const charge = jest.fn().mockResolvedValue({ amount: 13 })
+  const result = await charge({ customerId: 'c1', amount: 13 })
+  expect(result.amount).toBe(13)
+})
```
