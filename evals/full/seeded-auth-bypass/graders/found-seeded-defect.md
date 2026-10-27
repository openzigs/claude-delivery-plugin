---
type: regex
target: last_message
flags: i
pattern: '((no|missing|without( a)?|absent|empty) (auth(orization)? )?(header|token)|bypass|unauthenticated)[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect in src/middleware/auth.js. The reply must name it and end with `Recommendation: do not merge`, so a reply that waves the missing token through and approves scores 0.
