<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '@norbital-ai/ui/utils';
	import type {
		DetailStackEntry,
		DetailSurfaceResolver
	} from '$lib/ui/collection/detail/detail_stack.js';
	import DetailSurfaceStack from './detail-surface-stack.svelte';

	let {
		stack,
		resolveSurface,
		depth = 0,
		parentRouteKey,
		unresolvedFallback,
		actions
	}: {
		stack: DetailStackEntry[];
		resolveSurface: DetailSurfaceResolver;
		depth?: number;
		parentRouteKey?: string;
		unresolvedFallback?: Snippet<[{ entry: DetailStackEntry }]>;
		actions?: Snippet;
	} = $props();

	const entry = $derived(stack[depth] ?? null);
	const nextEntry = $derived(stack[depth + 1] ?? null);
	const isTopEntry = $derived(depth === stack.length - 1);
	const registration = $derived(
		entry ? resolveSurface(entry.routeKey, parentRouteKey ?? entry.parentRouteKey) : undefined
	);
</script>

{#if entry}
	<section
		class={cn(
			'absolute inset-0 min-h-0 min-w-0 overflow-clip bg-popover shadow-xl',
			!isTopEntry && 'pointer-events-none'
		)}
		aria-hidden={!isTopEntry}
		style={`z-index:${depth}`}
	>
		{#if registration?.renderDetail}
			{@render registration.renderDetail({ recordId: entry.recordId, actions })}
		{:else if unresolvedFallback}
			{@render unresolvedFallback({ entry })}
		{:else}
			<p class="p-4 text-sm text-muted-foreground">Record detail is unavailable.</p>
		{/if}
	</section>
	{#if nextEntry}
		<DetailSurfaceStack
			{stack}
			{resolveSurface}
			depth={depth + 1}
			parentRouteKey={entry.routeKey}
			{unresolvedFallback}
			{actions}
		/>
	{/if}
{/if}
