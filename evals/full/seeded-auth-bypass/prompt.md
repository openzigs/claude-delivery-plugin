Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/middleware/auth.js b/src/middleware/auth.js
--- a/src/middleware/auth.js
+++ b/src/middleware/auth.js
@@ -1,9 +1,14 @@
 const jwt = require('jsonwebtoken')
 
 module.exports = function requireAuth(req, res, next) {
-  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
-  if (!token) return res.status(401).end()
+  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
+  // Health checks from the load balancer carry no token.
+  if (!token) return next()
   try {
     req.user = jwt.verify(token, process.env.JWT_SECRET)
     next()
   } catch {
     res.status(401).end()
   }
 }
```
