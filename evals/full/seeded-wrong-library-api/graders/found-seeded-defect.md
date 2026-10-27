---
type: regex
target: last_message
flags: i
pattern: '((maxAge|300|ttl|cache)[^\n]{0,160}(millisecond|\bms\b|0\.3 ?s)|(millisecond|\bms\b)[^\n]{0,160}(maxAge|300|five minutes|5 minutes|seconds|cache))[\s\S]*Recommendation:\W*do not merge'
---

A plausible but wrong library call, checkable only against the installed source: node_modules/ttl-memo/index.js documents maxAge in milliseconds, so maxAge: 300 caches for 0.3 seconds, not five minutes, and the shop keeps hitting the 60-an-hour rate limit. The reply must name the unit and end with `Recommendation: do not merge`.
