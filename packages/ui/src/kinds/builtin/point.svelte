<!--
@component
The built-in `point` custom field's renderer: address search and map when edited; the address, coordinates and a map
when shown; one OpenStreetMap link in a dense line.
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import CopyText from '../../primitives/copy-text/copy-text.svelte';
	import type { CustomFieldView } from '../context.js';
	import { formatPoint, isPoint } from '../kind.js';
	import PointInput from '../point-input.svelte';
	import PointMap from '../point-map.svelte';

	let { view }: { view: CustomFieldView } = $props();
	const v = $derived(isPoint(view.value) ? view.value : null);
	const where = $derived(view.address?.value ?? null);
</script>

{#snippet link(p: { lat: number; lng: number })}
	<a
		class="inline-flex items-center gap-1 tabular-nums underline-offset-2 hover:underline"
		href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=16/${p.lat}/${p.lng}`}
		target="_blank"
		rel="noopener"
	>
		<Icon icon="lucide:map-pin" class="size-3.5" />{formatPoint(p)}
	</a>
{/snippet}

{#if view.mode === 'edit'}
	<PointInput value={view.value} onChange={view.onChange} address={where} onAddress={view.address?.onChange} id={view.id} disabled={view.disabled} invalid={view.error !== undefined} />
{:else if v === null}
	<span class="text-muted-foreground">—</span>
{:else if view.dense}
	{@render link(v)}
{:else}
	<div id={view.id} class="grid min-w-0 gap-1.5">
		{#if where !== null && where !== ''}<CopyText text={where} />{/if}
		<CopyText text={formatPoint(v)} class="text-meta tabular-nums">{@render link(v)}</CopyText>
		<PointMap value={v} class="h-40 sm:h-44" />
	</div>
{/if}
