Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/routes/users.js b/src/routes/users.js
--- a/src/routes/users.js
+++ b/src/routes/users.js
@@ -10,6 +10,14 @@ router.get('/users/:id', requireAuth, async (req, res) => {
   res.json(await db.users.findById(req.params.id))
 })
 
+// Search users by name for the admin console.
+router.get('/users', requireAuth, async (req, res) => {
+  const name = req.query.name || ''
+  const rows = await db.query("SELECT id, name, email FROM users WHERE name LIKE '%" + name + "%'")
+  res.json(rows)
+})
+
 module.exports = router
```
