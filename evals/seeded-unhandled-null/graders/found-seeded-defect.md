---
type: regex
target: last_message
flags: i
pattern: '(\bnull\b|undefined|not found|TypeError|no such user|missing user|unknown (user|id)|crash)[\s\S]*Recommendation:\W*do not merge'
---

The seeded defect in src/routes/users.js: findById resolves to null for an unknown id, and user.email then throws. The reply must name it and end with `Recommendation: do not merge`.
