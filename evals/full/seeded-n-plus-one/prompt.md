Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/routes/orders.js b/src/routes/orders.js
--- a/src/routes/orders.js
+++ b/src/routes/orders.js
@@ -3,6 +3,15 @@ const { db } = require('../db')
 
 const router = express.Router()
 
+// Order history for the signed-in user; power users have thousands of orders.
+router.get('/orders', requireAuth, async (req, res) => {
+  const orders = await db('orders').where({ user_id: req.user.id })
+  for (const order of orders) {
+    order.items = await db('order_items').where({ order_id: order.id })
+  }
+  res.json(orders)
+})
+
 module.exports = router
```
