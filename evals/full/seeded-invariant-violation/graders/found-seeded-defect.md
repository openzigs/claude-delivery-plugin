---
type: regex
target: last_message
flags: i
pattern: '((fraction|non-?integer|not an? (whole|integer)|integer|whole|round|decimal|float)[^\n]{0,100}(cent|amount|ledger)|(cent|amount|ledger)[^\n]{0,100}(fraction|non-?integer|not an? (whole|integer)|round|decimal|float))[\s\S]*Recommendation:\W*do not merge'
---

A new caller breaks an invariant stated only in an unchanged file: src/ledger.js says amounts are integer cents and that callers round before posting, and refundPercent posts order.total * percent / 100, a fractional amount for most totals (the test uses 2000 cents, which hides it). The reply must name the fractional or unrounded amount and end with `Recommendation: do not merge`.
