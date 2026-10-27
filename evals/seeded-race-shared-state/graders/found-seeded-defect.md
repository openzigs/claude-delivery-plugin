---
type: regex
target: last_message
flags: i
pattern: '(\brace\b|\bconcurren|\batomic|\btransaction|\block(s|ed|ing)?\b|lost update|TOCTOU|double[- ]spend)[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect in src/accounts/withdraw.js: a read-check-write on the balance with no transaction or lock, so two concurrent withdrawals can both pass the check. The reply must name it and end with `Recommendation: do not merge`.
