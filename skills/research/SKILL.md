---
name: research
agent: true
authoring: false
description: Protocol for web research, scraping and downloading.
---

1. Search, then open the primary source: the authority, publisher or vendor, not an aggregator.
2. Use the source's structured data or document text where available; inspect the rendered page or image when needed. Batch independent extraction while respecting the available tools and access constraints.
3. Follow pagination until the set is complete. Keep each value's URL and exact wording; cite it.
4. Media: save the file's own URL, never the page's. What a recording says comes only from its transcript; without one, say so.
5. When sources disagree, report the disagreement. Change records only if asked, citing the source.
6. Never export placeholder rows ("Pending research", "TBD", "not yet assessed") as completed deliverables: finish the research first, or pause and confirm scope/batch size with the person before exporting incomplete work. When writing a downloadable CSV, always prefix it with a UTF-8 BOM (`\uFEFF`) so Excel displays Unicode characters cleanly without mojibake.
