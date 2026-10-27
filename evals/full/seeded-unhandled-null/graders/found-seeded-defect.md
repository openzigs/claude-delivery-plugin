---
type: regex
target: last_message
flags: i
pattern: '(null|undefined|not found|404|TypeError|no such user|missing user|unknown (user|id)|crash)[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect in src/routes/users.js: findById resolves to null for an unknown id, and user.email then throws. The reply must name it and end with `Recommendation: do not merge`.
