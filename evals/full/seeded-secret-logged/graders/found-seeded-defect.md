---
type: regex
target: last_message
flags: i
pattern: '(log[^\n]{0,80}(password|credential|secret|plain ?text)|(password|credential|secret)[^\n]{0,80}log)[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect in src/auth/login.js: the whole request body, password included, is written to the log. The reply must name it and end with `Recommendation: do not merge`.
