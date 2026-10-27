---
type: regex
target: last_message
flags: i
pattern: '\b(critical|high|medium)\b(?=[^\n]*(expir|throw|reject|guard|new (branch|path|behaviou?r|check)))(?=[^\n]*(untested|not (tested|covered|exercised)|no test|missing test|uncovered|nothing tests|never (runs|tested|exercis|hit|reach)|(stays?|leaves? [^\n]{0,30}) green|still pass))'
---

The seeded defect in test/coupons.test.js: the change adds an expired-coupon branch, and the new test covers only the branch that already existed. The reply must name it at medium severity or above.
