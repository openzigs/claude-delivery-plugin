---
type: regex
target: last_message
flags: i
pattern: '\b(critical|high|medium)\b[^\n]*(its own mock|mock.?s? return|asserts? on the mock|never calls|not (call|exercis|test)|does not (call|exercise|test)|tautolog|cannot fail|always pass|chargeOrder[^\n]{0,40}(untested|never|not))'
---

The seeded defect in test/billing.test.js: the test calls its own mock and asserts on the mock's return value, so it never exercises chargeOrder and cannot fail. The reply must name it at medium severity or above.
