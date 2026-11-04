<!--
	What Norbius left for the person while its panel was closed, on its icon: a dot in the most pressing ending's colour
	(its parent is positioned), named for screen readers.
-->
<script lang="ts">
	import { cn } from '@norbital-ai/ui';
	import type { Awaiting } from './chime.ts';

	let { kind, t }: { kind: Awaiting | null; t: (text: string) => string } = $props();
	const LABEL = {
		input: 'Norbius is waiting for you',
		complete: 'Norbius finished',
		error: 'Norbius hit an error'
	} as const;
	const COLOR = { input: 'bg-warning', complete: 'bg-brand', error: 'bg-destructive' } as const;
</script>

{#if kind !== null}
	<span
		class={cn(
			'pointer-events-none absolute top-0 right-0 size-2 rounded-full ring-2 ring-background',
			COLOR[kind]
		)}
		aria-hidden="true"
		data-awaiting={kind}
	></span>
	<span class="sr-only">{t(LABEL[kind])}</span>
{/if}
