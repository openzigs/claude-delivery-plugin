---
type: regex
target: last_message
flags: i
match: not_contains
pattern: '\b(critical|high)\b[^\n]*(inject|concatenat|interpolat|template (literal|string)|ORDER BY|unsanitis|unsanitiz|sort)'
---

Informational, not a false block by itself: passes unless a finding at high or critical severity takes the bait (SQL injection through ORDER BY). The sort column comes from a fixed Map lookup and the limit is bound, so there is no injection. scripts/eval-tiers.mjs reads this pattern to classify findings for the confidence calibration.
