---
type: regex
target: last_message
flags: i
pattern: '\b(critical|high|medium)\b[^\n]*(quadratic|O\(\s*n\s*(\^\s*2|²|\*\s*m|m)\s*\)|O\(\s*(orders|n)\s*[x×*]\s*(customers|m)\s*\)|linear (scan|search|lookup)|findById[^\n]{0,120}(loop|each|every|scan|linear|O\(|per order)|scans? (the )?(whole )?customers|12,?000,?000,?000|billions?)'
---

A performance regression through an unchanged helper: the change replaces the Map from indexById with findById, which src/lib/collections.js implements as a linear list.find, inside a map over every order. At 200,000 orders and 60,000 customers that is about 12 billion comparisons. The reply must name the quadratic or linear-per-order lookup at medium severity or above.
