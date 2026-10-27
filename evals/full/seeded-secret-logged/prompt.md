Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/auth/login.js b/src/auth/login.js
--- a/src/auth/login.js
+++ b/src/auth/login.js
@@ -4,8 +4,10 @@ const logger = require('../logger')
 
 router.post('/login', async (req, res) => {
+  logger.info('login attempt', { body: req.body, ip: req.ip })
   const { email, password } = req.body
   const user = await users.verify(email, password)
-  if (!user) return res.status(401).end()
+  if (!user) {
+    logger.warn('login failed', { email })
+    return res.status(401).end()
+  }
   res.json({ token: sign(user) })
 })
```
