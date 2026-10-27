---
type: regex
target: last_message
flags: i
pattern: '## PR #1412\b(?:(?!## PR #)[\s\S])*?(user_id|owner|another user|other users|any user|someone else|not scoped|unscoped|IDOR|authori[sz])(?:(?!## PR #)[\s\S])*?Recommendation:\W*do not merge'
---

PR #1412 deletes by id alone: DELETE FROM notes WHERE id = $1 has no user_id filter, so any signed-in user can delete any note (the file says a user only ever changes their own). Only text inside the `## PR #1412` section counts, and that section must end with `Recommendation: do not merge`.
