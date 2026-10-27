---
type: regex
target: last_message
flags: i
pattern: '(four[- ]eyes|own refund|self[- ]approv|approv[^\n]{0,120}(their own|own request|requester|requested_by|same (user|person))|requester[^\n]{0,120}approv|requested_by[^\n]{0,120}(approv|check)|segregation of duties|separation of duties|rule 6)[\s\S]*Recommendation:\W*do not merge'
---

One real defect buried in a 400+ line change: docs/refunds.md (rule 6, the four-eyes rule) says the requester of a refund can never approve it, and approveRefund checks the role and the status but never compares refund.requested_by with the approver. Finance staff also raise refunds, so one person can request and approve their own. The reply must name it and end with `Recommendation: do not merge`.
