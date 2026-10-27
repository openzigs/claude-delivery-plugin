---
type: regex
target: last_message
flags: i
pattern: '((admin|role|authori[sz]|privileg|permission|requireRole)[^\n]{0,150}(payout|export|reports)|(payout|export|reports)[^\n]{0,150}(admin|role|authori[sz]|privileg|permission|requireRole|any (signed-in|logged-in|authenticated) (user|seller)|every seller|non-admin))[\s\S]*Recommendation:\W*do not merge'
---

A "pure move" drops an authorisation check that lives in an unchanged file: src/app.js mounts /admin behind requireRole("admin") but /reports behind requireAuth only, so moving the payouts export (bank details of every seller) into routes/reports.js exposes it to any signed-in seller. The reply must tie the export to the lost admin check and end with `Recommendation: do not merge`.
