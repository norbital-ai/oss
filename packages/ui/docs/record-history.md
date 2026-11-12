# Native record history

Every stored `RecordShell` provides one History popover containing the primary record’s revision
scrubber and its change timeline. Each entry shows its absolute time and how long ago it was. Picking a
primary revision shows that record read-only; End returns to its current revision. The record's current
revision anchors the timeline; the rest are newest first, with its own revisions ahead of related ones at
an equal instant. Related-record changes stay individually identified, and a related revision with no
visible field changes is left out.

Use `history` to include related models: each source names its model and the `where` that selects its records
(read through the viewer's ordinary scoped read request, up to 10,000 records):

```svelte
<RecordShell
	of="projects"
	id={project_id}
	history={{
		sources: [
			{ of: 'trials', where: { project_id: { eq: project_id } } },
			{ of: 'submissions', where: { project_id: { eq: project_id } } }
		]
	}}
/>
```

A registered representation’s inner shell can supply this configuration to the outer shell’s native
History control. Optional `fields` on the configuration or an individual source restrict the displayed
change labels. Native read/history permissions still apply; a revision shows only the fields of the output it reads.
History loads on demand. Related queries refresh when the popover opens, and partial failures are reported
without hiding the primary record’s history. No additional event model or template-specific timeline is needed.
