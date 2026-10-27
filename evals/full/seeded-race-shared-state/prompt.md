Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/accounts/withdraw.js b/src/accounts/withdraw.js
--- a/src/accounts/withdraw.js
+++ b/src/accounts/withdraw.js
@@ -1,3 +1,11 @@
 import { db } from '../db'
 
+// Called by POST /accounts/:id/withdraw; clients may retry or submit in parallel.
+export async function withdraw(accountId, amount) {
+  const { balance } = await db('accounts').where({ id: accountId }).first()
+  if (balance < amount) throw new Error('insufficient funds')
+  await db('accounts').where({ id: accountId }).update({ balance: balance - amount })
+  return balance - amount
+}
```
