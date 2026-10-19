# Native record history

Every stored `RecordShell` provides one History popover containing the primary record’s revision
scrubber and its chronological change timeline. Picking a primary revision shows that record read-only;
End returns to its current revision. Related-record changes remain individually identified in the timeline.

Use `history` to include related collections through ordinary scoped read queries:

```svelte
<RecordShell
	of="projects"
	id={projectId}
	history={{
		sources: [
			{ of: 'trials', query: { where: { project_id: { eq: projectId } }, all: true } },
			{ of: 'submissions', query: { where: { project_id: { eq: projectId } }, all: true } }
		]
	}}
/>
```

A registered representation’s inner shell can supply this configuration to the outer shell’s native
History control. Optional `fields` on the configuration or an individual source restrict the displayed
change labels. Native read/history permissions still apply; masked changes and hidden fields are omitted.
History loads on demand. Related queries refresh when the popover opens, and partial failures are reported
without hiding the primary record’s history. No additional event model or template-specific timeline is needed.
