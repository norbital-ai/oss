<script lang="ts">
	// A filter row's words on one line (a chip, the author's scope): field, operator and value styled apart, truncated,
	// the whole sentence in the tooltip.
	import { cn } from '../primitives/utils.js';
	import { partsText, spaced, type Part } from './filter.js';

	let { parts, class: className }: { parts: readonly Part[]; class?: string } = $props();
	const ROLE = {
		field: 'text-foreground font-medium',
		op: 'text-muted-foreground',
		value: 'text-foreground',
		join: 'text-muted-foreground italic'
	} as const;
</script>

<span class={cn('min-w-0 truncate', className)} title={partsText(parts)} data-filter-summary
	>{#each parts as p, i (i)}{spaced(parts, i) ? ' ' : ''}<span
			class={ROLE[p.role]}
			data-part={p.role}>{p.text}</span
		>{/each}</span
>
