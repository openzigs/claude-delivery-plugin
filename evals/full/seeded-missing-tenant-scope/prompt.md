Review this pull request diff. Do a FULL review: requirements, design, security,
correctness, performance and tests of the change. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/invoices/repository.ts b/src/invoices/repository.ts
--- a/src/invoices/repository.ts
+++ b/src/invoices/repository.ts
@@ -1,12 +1,20 @@
 import { db } from '../db'
 
 export async function listInvoices(tenantId: string) {
   return db('invoices').where({ tenant_id: tenantId })
 }
+
+// Called by GET /tenants/:tenantId/invoices/:invoiceId
+export async function getInvoice(tenantId: string, invoiceId: string) {
+  return db('invoices').where({ id: invoiceId }).first()
+}
+
+export async function markPaid(tenantId: string, invoiceId: string) {
+  return db('invoices').where({ tenant_id: tenantId, id: invoiceId }).update({ paid: true })
+}
```
