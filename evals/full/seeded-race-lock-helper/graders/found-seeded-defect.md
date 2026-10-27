---
type: regex
target: last_message
flags: i
pattern: '((withLock|\block\b)[^\n]{0,160}(releas|not await|n.t await|without await|awaits? nothing|returns? (a |the )?promise|before the (async|await|callback|promise|write|update)|synchronous|immediately|not held|does not (hold|wait|serial))|(releas|not await|n.t await|synchronous)[^\n]{0,160}\block)[\s\S]*Recommendation:\W*do not merge'
---

A race that only the unchanged lock helper shows: src/lib/lock.js returns fn() without awaiting it, so for an async callback the lock is released as soon as the promise is created, and the read-check-write in reserve() is not serialised at all. A reply that only says "race" or "use a transaction" without seeing that the lock is released early does not pass. It must end with `Recommendation: do not merge`.
