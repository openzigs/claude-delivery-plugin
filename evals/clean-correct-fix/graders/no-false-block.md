---
type: regex
target: last_message
flags: i
pattern: 'Recommendation:\W*merge\b'
---

A correct fix for an off-by-one in a loop bound, with a test that fails without it. There is nothing to block, so the reply must end with `Recommendation: merge`. A do-not-merge verdict scores 0 and counts as a false block.
