---
type: regex
target: last_message
flags: i
pattern: '\b(critical|high|medium)\b[^\n]*(N ?\+ ?1|quer(y|ies) (per|for each|in a loop|inside the loop)|one query per|whereIn|round[- ]trips?)'
---

The seeded defect in src/routes/orders.js: one query per order inside the loop (N+1). Graded on the finding at medium or above, not on the verdict: the security rule makes a performance finding a follow-up unless it is severe. The reply must name it at medium severity or above.
