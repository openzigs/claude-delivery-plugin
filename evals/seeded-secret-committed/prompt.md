Review this pull request diff. Do a LIGHT review: security and correctness of the changed
lines only. There is no GitHub PR, no repository and no network: do not run `gh`, do not
publish anything, and do not ask questions. Reply with every finding on its own line as
`file:line — severity — finding`, then a final line `Recommendation: merge` or
`Recommendation: do not merge`.

```diff
diff --git a/src/payments/client.js b/src/payments/client.js
--- a/src/payments/client.js
+++ b/src/payments/client.js
@@ -1,6 +1,8 @@
 const Gateway = require('payment-gateway')
 
-const gateway = new Gateway(process.env.PAYMENT_API_KEY)
+// Temporary: the staging env var keeps getting unset, so pin the key here.
+const PAYMENT_API_KEY = 'pgw_secret_51Hx9QeLkT2vB8nR4sWm0ZyA7cD3fG6hJ'
+const gateway = new Gateway(PAYMENT_API_KEY)
 
 module.exports = { charge: (opts) => gateway.charges.create(opts) }
```
