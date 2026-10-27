Review this pull request diff. Do a LIGHT review: security and correctness of the changed
lines only. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/lib/chunk.js b/src/lib/chunk.js
--- a/src/lib/chunk.js
+++ b/src/lib/chunk.js
@@ -1,7 +1,7 @@
 export function chunk(items, size) {
   const out = []
-  for (let i = 0; i < items.length - 1; i += size) {
+  for (let i = 0; i < items.length; i += size) {
     out.push(items.slice(i, i + size))
   }
   return out
 }
diff --git a/test/chunk.test.js b/test/chunk.test.js
--- a/test/chunk.test.js
+++ b/test/chunk.test.js
@@ -4,3 +4,7 @@ import { chunk } from '../src/lib/chunk'
 test('chunk splits evenly', () => {
   expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
 })
+
+test('chunk keeps a trailing single item', () => {
+  expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]])
+})
```
