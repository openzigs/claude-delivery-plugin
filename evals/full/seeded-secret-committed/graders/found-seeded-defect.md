---
type: regex
target: last_message
flags: i
pattern: '(hard-?coded|committed|in (the )?source|secret|api key|live key|credential)[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect in src/payments/client.js: a live API key is committed in source. The reply must name it and end with `Recommendation: do not merge`.
