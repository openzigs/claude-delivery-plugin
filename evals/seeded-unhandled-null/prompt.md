Review this pull request diff. Do a LIGHT review: security and correctness of the changed
lines only. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/routes/users.js b/src/routes/users.js
--- a/src/routes/users.js
+++ b/src/routes/users.js
@@ -10,6 +10,12 @@ router.get('/users/:id', requireAuth, async (req, res) => {
   res.json(await db.users.findById(req.params.id))
 })
 
+// findById resolves to null when there is no such user.
+router.get('/users/:id/email', requireAuth, async (req, res) => {
+  const user = await db.users.findById(req.params.id)
+  res.json({ email: user.email.toLowerCase() })
+})
+
 module.exports = router
```
