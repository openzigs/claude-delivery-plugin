---
type: regex
target: last_message
flags: i
pattern: '(enumerat|(reveal|disclos|leak|discover|tell|expos|confirm)[^\n]{0,80}(account|email|user)s?[^\n]{0,60}(exist|regist)|404[^\n]{0,150}(account|exist|identical|same|threat|requirement|issue)|(identical|same) (response|status|body))[\s\S]*Recommendation:\W*do not merge'
---

A requirement stated only in the linked issue (.pr/issue-412.md), not in any code comment: the response must be identical whether or not an account exists. The endpoint returns 404 for an unknown email, which lets anyone find out which emails have accounts. The reply must name it and end with `Recommendation: do not merge`.
