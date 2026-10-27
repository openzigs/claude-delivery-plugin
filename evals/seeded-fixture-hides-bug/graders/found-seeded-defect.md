---
type: regex
target: last_message
flags: i
pattern: '\b(critical|high|medium)\b[^\n]*(case[- ]?(in)?sensitiv|lower-?case|toLowerCase|normali[sz]e ?Email|mixed[- ]case|upper-?case|capitali[sz])'
---

A test that passes only because its fixture hides the bug: findDuplicates compares raw emails, while src/users/model.js says emails are stored mixed-case and must be compared through normaliseEmail(); test/fixtures/users.json holds only lower-case duplicates, so the tests pass. The reply must name the case-sensitive comparison at medium severity or above.
