---
type: regex
target: last_message
flags: i
pattern: 'Recommendation:\W*merge\b'
---

A documentation-only change. There is nothing to block, so the reply must end with `Recommendation: merge`. A do-not-merge verdict scores 0 and counts as a false block.
