---
type: regex
target: last_message
flags: i
pattern: '(inject|parameteri[sz]|placeholder|prepared statement|concatenat)[\s\S]*Recommendation:\W*do not merge'
---

The seeded defect in src/routes/users.js. The reply must name it and end with `Recommendation: do not merge`, so a reply that dismisses it and approves scores 0.
