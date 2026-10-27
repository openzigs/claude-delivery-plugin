Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/jobs/retry.js b/src/jobs/retry.js
--- a/src/jobs/retry.js
+++ b/src/jobs/retry.js
@@ -1,7 +1,8 @@
 const { RETRY_LIMIT } = require('../config')
 
 async function withRetry(fn) {
-  for (let i = 0; i < 3; i++) {
-    try { return await fn() } catch (e) { if (i === 2) throw e }
+  const limit = Number.isInteger(RETRY_LIMIT) && RETRY_LIMIT > 0 ? RETRY_LIMIT : 3
+  for (let i = 0; i < limit; i++) {
+    try { return await fn() } catch (e) { if (i === limit - 1) throw e }
   }
 }
```
