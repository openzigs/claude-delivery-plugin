Review this pull request diff. Do a LIGHT review: security and correctness of the changed
lines only. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/jobs/retry.js b/src/jobs/retry.js
--- a/src/jobs/retry.js
+++ b/src/jobs/retry.js
@@ -1,8 +1,10 @@
 const { RETRY_LIMIT } = require('../config')
 
 async function withRetry(fn) {
-  for (let i = 0; i < 3; i++) {
+  for (let i = 0; i < RETRY_LIMIT; i++) {
     try { return await fn() } catch (e) { if (i === RETRY_LIMIT - 1) throw e }
   }
 }
```
