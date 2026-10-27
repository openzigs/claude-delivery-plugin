---
type: regex
target: last_message
flags: i
pattern: '((revenue|dailyRevenue|SUM\(total\)|reports?/)[^\n]{0,160}(total\b|column|renam|break|fail|no longer|still|error)|(renam|total_cents|migration)[^\n]{0,160}(revenue|dailyRevenue|report))[\s\S]*Recommendation:\W*do not merge'
---

A migration that is correct on its own but breaks an unchanged query: it renames orders.total to total_cents and updates the order repository, while src/reports/revenue.js still selects SUM(total) and will fail. The reply must name the revenue report (or its query) and end with `Recommendation: do not merge`.
