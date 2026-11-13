<!--
@component
A Bolt concept's icon (`workspace`, `models`, `approvals` …): a line glyph in the current colour with one stroke in the
brand accent. Set `--product-icon-accent` on an ancestor to repaint the accent (`currentColor` for a monochrome glyph).
-->
<script lang="ts">
	import { CONCEPT_ICONS, type ConceptName } from './concept-icons.js';

	let {
		name,
		class: className = 'size-4'
	}: {
		/** The concept drawn. */
		name: ConceptName;
		/** Classes on the svg (size and colour). Default `size-4`. */
		class?: string;
	} = $props();
</script>

<svg
	viewBox="0 0 24 24"
	class={className}
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	data-concept-icon={name}
>
	{@html CONCEPT_ICONS[name].base}
	<g style="stroke: var(--product-icon-accent, var(--color-brand))">{@html CONCEPT_ICONS[name].accent}</g>
</svg>
