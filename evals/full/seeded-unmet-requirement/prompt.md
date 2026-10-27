Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

The pull request says it closes this issue:

> **Export orders as CSV**
> Acceptance criteria:
> - [ ] GET /orders/export returns text/csv with a header row
> - [ ] dates are ISO 8601
> - [ ] the export honours the `from` and `to` query parameters (an inclusive date range)

```diff
diff --git a/src/routes/export.js b/src/routes/export.js
--- a/src/routes/export.js
+++ b/src/routes/export.js
@@ -1,5 +1,16 @@
 const { db } = require('../db')
 
+router.get('/orders/export', requireAuth, async (req, res) => {
+  const rows = await db('orders').where({ user_id: req.user.id }).orderBy('created_at')
+  const lines = ['id,created_at,total']
+  for (const r of rows) {
+    lines.push([r.id, new Date(r.created_at).toISOString(), r.total].join(','))
+  }
+  res.type('text/csv').send(lines.join('\n'))
+})
+
 module.exports = router
```
