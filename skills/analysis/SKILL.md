---
name: analysis
agent: true
authoring: false
description: Protocol for analysing data and producing charts and reports.
---

1. A count is a read's total. A sum, average or group is one read with aggregate. Read rows only for what those cannot give.
2. Preserve units, currencies, time zones and granularity. Group incompatible measures separately; convert only with an explicit rate, time and source, keeping original values.
3. Anything further is run_js over the read's rows; verify its totals against an aggregate.
4. A chart is an SVG file run_js returns. A report is document, with numbers as tables and charts inline.
5. State what the numbers show, the scope and missing data. Separate observations, calculations and interpretations.
6. Derive validity rules and exclusions from declared constraints, the task or supplied evidence. Flag an unverified anomaly without silently correcting it or excluding it from the analysis.
7. Never deliver placeholder rows ("Pending research", "TBD", "not yet assessed") as finished output — complete the work or confirm scope first. Prefix generated CSV downloads with a UTF-8 BOM (`\uFEFF`) so Excel renders non-ASCII text without mojibake.
