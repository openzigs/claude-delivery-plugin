---
type: regex
target: last_message
flags: i
pattern: '## PR #1415\b(?:(?!## PR #)[\s\S])*?Recommendation:\W*merge\b'
---

PR #1415 documents slugify, renames a local and adds tests, with no behaviour change: nothing to block. Its section must end with `Recommendation: merge`; a do-not-merge verdict there is a false block.
