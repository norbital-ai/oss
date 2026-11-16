---
name: ingest
agent: true
authoring: false
description: Protocol for taking in documents, scans, photos, handwriting, sheets or messages, whether or not they touch records.
---

1. Reading, summarising or checking material writes nothing. Filing or acting on it follows rules 5 to 7; matching against records happens only when the task calls for it.
2. Read every file, page and sheet. A locked PDF or Office file needs the password the person gave.
3. An image's values come from the image itself. Crossings-out, corrections and margin notes are data: report what stands and what was struck. Check any stated relationships, units, totals and constraints when relevant. A mismatch may be a source error, rounding or a misread: recheck the source, preserve both values and report the discrepancy. Never replace a source value merely to make a check pass. Label unclear readings uncertain; ask only when the uncertainty blocks the task.
4. Comparing documents: line by line, every field; report each difference with both values.
5. Map every target column to a source value, its kind and whether it is required; trace each value to where it was read.
6. Resolve every relational field by an exact read of its source identifier. Decide LINK, CREATE or UPDATE, or REFUSE naming the field; only a required field refuses, an optional unreadable one stays empty. Never take the closest name, the current user or another row's record. Find an existing root by its source identity first; an unchanged repeat writes nothing.
7. Numbers from a table or a file's data are computed from the file, never retyped. Report the root and every relational field as model.field → target, decision, value; distinguish quoted, derived and uncertain values. Do not invent missing facts. Synthetic data is allowed only when requested and must be labelled.
