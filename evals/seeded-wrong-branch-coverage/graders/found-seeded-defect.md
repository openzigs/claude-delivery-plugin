---
type: regex
target: last_message
flags: i
pattern: '\b(critical|high|medium)\b[^\n]*(expir[^\n]{0,80}(untested|not (tested|covered)|no test|missing|uncovered)|(untested|not (tested|covered)|no test|missing test|uncovered)[^\n]{0,80}(expir|new branch|throw))'
---

The seeded defect in test/coupons.test.js: the change adds an expired-coupon branch, and the new test covers only the branch that already existed. The reply must name it at medium severity or above.
