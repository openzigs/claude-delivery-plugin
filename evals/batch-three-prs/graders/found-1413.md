---
type: regex
target: last_message
flags: i
pattern: '## PR #1413\b(?:(?!## PR #)[\s\S])*?((string|ISO|NaN|type|coerc|parse)[^\n]{0,160}(due_at|due date|Date|compar)|(due_at|due date|compar)[^\n]{0,160}(string|ISO|NaN|coerc|never|always false|parse))(?:(?!## PR #)[\s\S])*?Recommendation:\W*do not merge'
---

PR #1413 compares note.due_at with a Date, but src/db.js returns timestamptz columns as ISO strings, so the comparison is always false and no reminder is ever sent; the test passes only because its fixture uses Date objects. Only text inside the `## PR #1413` section counts, and that section must end with `Recommendation: do not merge`.
