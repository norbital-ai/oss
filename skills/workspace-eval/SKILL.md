---
name: workspace-eval
agent: true
authoring: true
description: How to grade a workspace against its brief before merge.
---

1. Read the brief, the design note, the source, the preview report and the tests. The question is requirement fit, not taste.
2. For every requirement, name the page, section, model or automation that serves it and the evidence that it works. A surface with no requirement is a finding.
3. Ask what could be deleted or inlined. A model that only arranges a screen, a page that repeats another page, a section that could be a field: each is a finding with the requirement it fails to justify.
4. Check live versus stored: an external value is a read unless a stated history or audit requirement needs a record.
5. Check the UI evidence: every page scrolls, the shell and forms are used, representations exist for record views, artwork loads, no console errors.
6. Score requirement fit, simplicity, data shape, UI and verification from 0 to 4. Verdict: pass only when every requirement is traced and every finding is fixed or explicitly accepted by the person.
