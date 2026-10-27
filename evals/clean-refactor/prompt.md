Review this pull request diff. Do a LIGHT review: security and correctness of the changed
lines only. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/format.js b/src/format.js
--- a/src/format.js
+++ b/src/format.js
@@ -1,9 +1,11 @@
+const money = (cents) => (cents / 100).toFixed(2)
+
 export function formatLine(line) {
-  return `${line.name}: ${(line.cents / 100).toFixed(2)}`
+  return `${line.name}: ${money(line.cents)}`
 }
 
 export function formatTotal(cents) {
-  return `Total: ${(cents / 100).toFixed(2)}`
+  return `Total: ${money(cents)}`
 }
```
