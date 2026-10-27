Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/lib/paginate.js b/src/lib/paginate.js
--- a/src/lib/paginate.js
+++ b/src/lib/paginate.js
@@ -1,3 +1,10 @@
+// page is 1-based; returns at most pageSize items.
+export function paginate(items, page, pageSize) {
+  const start = (page - 1) * pageSize
+  return items.slice(start, start + pageSize - 1)
+}
+
 export function pageCount(total, pageSize) {
   return Math.ceil(total / pageSize)
 }
```
