---
type: regex
target: last_message
flags: i
pattern: '((date[- ]range|range filter|from\/to|\bfrom\b[^\n]{0,20}\bto\b|acceptance criteri)[^\n]{0,80}(not|ignor|missing|unmet|never|lack)|(not|ignor|missing|unmet|never|lack)[^\n]{0,80}(date[- ]range|range filter|from\/to|acceptance criteri))[\s\S]*Recommendation:\s*do not merge'
---

The seeded defect: the linked issue requires the export to honour the from/to date range, and the diff ignores it. The reply must name it and end with `Recommendation: do not merge`.
