---
type: regex
target: last_message
flags: i
match: not_contains
pattern: '\b(critical|high)\b[^\n]*(pk_live|publishable|hard-?coded|secret|api key|credential|committed|stripe key)'
---

Informational, not a false block by itself: passes unless a finding at high or critical severity takes the bait (a hardcoded "live key"). A Stripe publishable key is public by design and the secret key stays on the server. scripts/eval-tiers.mjs reads this pattern to classify findings for the confidence calibration.
