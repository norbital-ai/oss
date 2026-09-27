<script lang="ts" generics="T">
	// Every view's non-ready states in one place: loading, "No access to <label>" (never an empty list) and a named error.
	import type { Snippet } from 'svelte';
	import Alert from '../primitives/alert/alert.svelte';
	import { useBolt } from './bolt.js';
	import EmptyState from './EmptyState.svelte';
	import Glyph from './Glyph.svelte';
	import { msg, type ReadState } from './model.js';

	/** `skeleton` replaces the default one (rows of a table) with the view's own shape (a board's cards). */
	let { state, what, children, skeleton }: { state: ReadState<T>; what: string; children: Snippet<[T]>; skeleton?: Snippet } = $props();
	const bolt = useBolt();
</script>

{#if state.kind === 'ready'}
	{@render children(state.value)}
{:else if state.kind === 'loading'}
	<!-- a skeleton the size of a short page, so the ready view does not jump in -->
	<div role="status" aria-busy="true" aria-label={msg(bolt, 'view.loading', 'Loading')} data-read="loading">
		{#if skeleton}{@render skeleton()}
		{:else}
			<div class="bg-card divide-y overflow-hidden rounded-md border">
				<div class="bg-muted h-9"></div>
				{#each [62, 80, 48, 71, 55, 66] as w, i (i)}
					<div class="flex items-center gap-4 px-3 py-2.5">
						<div class="bg-muted h-3.5 animate-pulse rounded motion-reduce:animate-none" style="width:{w * 0.4}%"></div>
						<div class="bg-muted h-3 flex-1 animate-pulse rounded motion-reduce:animate-none" style="max-width:{w * 0.5}%"></div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{:else if state.kind === 'noAccess'}
	<EmptyState icon="lock" read="noAccess" variant="card" title={msg(bolt, 'view.noAccess', 'No access to {what}', { what })} />
{:else}
	<Alert variant="destructive" data-read="error">
		<Glyph name="alert" class="size-4" />
		<div class="flex flex-col gap-1 text-sm">
			<p class="font-medium">{msg(bolt, 'view.errorTitle', '{what} could not be loaded', { what })}</p>
			<p class="break-words opacity-90">{msg(bolt, 'view.error', '{what} could not be read ({code}): {message}', { what, code: state.code, message: state.message })}</p>
		</div>
	</Alert>
{/if}
