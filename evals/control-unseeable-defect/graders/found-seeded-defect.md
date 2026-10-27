---
type: regex
target: last_message
flags: i
pattern: 'RETRY_LIMIT[^\n]{0,80}\b4096\b[\s\S]*Recommendation:\W*do not merge'
---

The seeded defect is outside the diff: config.js sets RETRY_LIMIT to 4096, and no reviewer can see that value. The grader is shaped like the seeded ones (defect named, then a do-not-merge verdict), so it can pass, but only by guessing a number the diff does not show. This case should score 0 on a real run.
