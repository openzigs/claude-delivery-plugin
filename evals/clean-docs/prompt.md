Review this pull request diff. Do a LIGHT review: security and correctness of the changed
lines only. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -12,7 +12,10 @@ npm install
 
 ## Running the tests
 
-Run `npm test`.
+Run `npm test` for the unit suite. The integration suite needs a local database:
+
+    docker compose up -d db
+    npm run test:integration
 
 ## License
```
