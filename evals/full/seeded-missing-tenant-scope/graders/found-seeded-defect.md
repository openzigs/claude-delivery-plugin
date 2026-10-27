---
type: regex
target: last_message
flags: i
pattern: '((missing|without|not|no|ignor|unused|lacks?)[^\n]{0,60}tenant|tenant[^\n]{0,60}(missing|not (used|checked|filtered|scoped|applied)|ignored|unused)|IDOR|cross-tenant|other tenant)[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect in src/invoices/repository.ts. The reply must name it and end with `Recommendation: do not merge`.
