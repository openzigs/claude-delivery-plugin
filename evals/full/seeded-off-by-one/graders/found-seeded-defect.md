---
type: regex
target: last_message
flags: i
pattern: '(off[- ]by[- ]one|exclusive|one (item|element|row|record)? ?(short|fewer|too few)|fewer than pageSize|drops?[^\n]{0,40}last|pageSize ?- ?1|missing[^\n]{0,30}(item|element|row|last))[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect in src/lib/paginate.js: slice() excludes its end index, so every page returns pageSize - 1 items. The reply must name it and end with `Recommendation: do not merge`.
