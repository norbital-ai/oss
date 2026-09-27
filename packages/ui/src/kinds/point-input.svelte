<!--
@component
Edits a `point`: one search box for an address or typed coordinates, the map following what is typed, a click or marker
drag on the map, and the browser's location.
-->
<script lang="ts" module>
	import type { Json } from './kind.js';

	/**
	 * A `point` field (P19, rule 69). Typing an address geocodes it (the host's geocoder, else the keyless default) and the
	 * map and value follow the best match; typed "lat, lng" is taken as is. A pick on the map, a marker drag or "use my
	 * location" set the point and look up its address. `address` is the sibling text field's value, shown in the box;
	 * `onAddress` receives what the box holds (`Field address="<field>"` wires both).
	 */
	export type PointInputProps = {
		value: Json;
		onChange(next: Json): void;
		address?: string | null;
		onAddress?(address: string | null): void;
		id?: string;
		disabled?: boolean;
		invalid?: boolean;
		/** Show the map (default true). */
		map?: boolean;
	};
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import Button from '../primitives/button/button.svelte';
	import Input from '../primitives/input/input.svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import { DEFAULT_GEOCODER, useKinds, type Geocoder } from './context.js';
	import { formatPoint, isPoint, parsePoint, untag, type Point } from './kind.js';
	import PointMap from './point-map.svelte';

	let { value, onChange, address = null, onAddress, id, disabled = false, invalid = false, map = true }: PointInputProps = $props();
	const host = useKinds();
	const geocoder: Geocoder = host.geocoder ?? DEFAULT_GEOCODER;
	const t = uiText();
	const uid = $props.id();
	const point = $derived(((v) => (isPoint(v) ? v : null))(untag(value)));

	type Hit = { point: Point; address: string };
	let text = $state(''), focused = $state(false), looked = $state<string | null>(null);
	let hits = $state<readonly Hit[]>([]), active = $state(0), searching = $state(false), failed = $state(false);
	// the box shows the stored address, else the address last looked up for the point, else its coordinates; never while typing
	const shown = $derived(address ?? looked ?? (point === null ? '' : formatPoint(point)));
	$effect.pre(() => { const s = shown; if (!focused) text = s; });

	let timer: ReturnType<typeof setTimeout> | undefined, asked = 0;
	function typed(q: string) {
		text = q;
		looked = null;
		clearTimeout(timer);
		hits = [];
		const at = parsePoint(q);
		if (at !== null) {
			// typed coordinates are the value; their address (stale otherwise) is looked up once typing stops
			onChange(at);
			onAddress?.(null);
			const n = ++asked;
			timer = setTimeout(async () => {
				const name = await geocoder.reverse?.(at).catch(() => null);
				if (n === asked && name) { looked = name; onAddress?.(name); }
			}, 600);
			return;
		}
		onAddress?.(q.trim() === '' ? null : q);
		if (q.trim() === '') return onChange(null);
		if (q.trim().length < 3) return;
		const n = ++asked;
		timer = setTimeout(async () => {
			searching = true;
			try {
				const found = await geocoder.search(q.trim());
				if (n !== asked) return;
				hits = found.slice(0, 5);
				failed = false;
				active = 0;
				// the map (and the value) follow the best match while the address is still being typed
				if (hits[0]) onChange(hits[0].point);
			} catch { if (n === asked) { hits = []; failed = true; } } finally { if (n === asked) searching = false; }
		}, 350);
	}
	function preview(i: number) { active = i; if (hits[i]) onChange(hits[i].point); }
	function choose(hit: Hit) {
		asked++;
		hits = [];
		text = hit.address;
		onChange(hit.point);
		onAddress?.(hit.address);
		looked = hit.address;
	}
	/** A point from the map or the device: set it, then name it when the geocoder can. */
	async function set(p: Point) {
		const n = ++asked;
		hits = [];
		onChange(p);
		looked = null;
		text = formatPoint(p);
		const name = await geocoder.reverse?.(p).catch(() => null);
		if (n !== asked || !name) return;
		looked = name;
		text = name;
		onAddress?.(name);
	}
	function keys(e: KeyboardEvent) {
		if (hits.length === 0) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); preview((active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length); }
		else if (e.key === 'Enter') { e.preventDefault(); choose(hits[active]!); }
		else if (e.key === 'Escape') hits = [];
	}

	const canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator;
	let locating = $state(false), locateError = $state(false);
	function locate() {
		locating = true;
		locateError = false;
		navigator.geolocation.getCurrentPosition(
			(pos) => { locating = false; void set({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) }); },
			() => { locating = false; locateError = true; },
			{ enableHighAccuracy: true, timeout: 15_000 }
		);
	}
</script>

<div class="grid min-w-0 gap-2">
	<div class="flex items-center gap-2">
		<div class="relative min-w-0 flex-1">
			<Icon icon={searching ? 'lucide:loader-circle' : 'lucide:map-pin'} class={cn('pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground', searching && 'animate-spin')} />
			<Input
				{id}
				value={text}
				oninput={(e) => typed(e.currentTarget.value)}
				onkeydown={keys}
				onfocus={() => (focused = true)}
				onblur={() => (focused = false)}
				placeholder={t('searchAddress')}
				autocomplete="off"
				role="combobox"
				aria-expanded={hits.length > 0}
				aria-controls={`${uid}-places`}
				aria-invalid={invalid ? 'true' : undefined}
				class="pl-8"
				{disabled}
			/>
		</div>
		{#if canLocate}
			<Button type="button" variant="outline" size="icon" onclick={locate} disabled={disabled || locating} aria-label={t('useMyLocation')} title={t('useMyLocation')}>
				<Icon icon={locating ? 'lucide:loader-circle' : 'lucide:locate-fixed'} class={cn('size-4', locating && 'animate-spin')} />
			</Button>
		{/if}
	</div>
	{#if map}<PointMap value={point} onPick={(p) => void set(p)} {disabled} />{/if}
	{#if hits.length > 0}
		<!-- below the map, so the map the typing moves stays in view -->
		<ul id={`${uid}-places`} class="grid gap-0.5 rounded-md border bg-popover p-1 shadow-sm" role="listbox">
			{#each hits as hit, i (`${hit.point.lat},${hit.point.lng},${hit.address}`)}
				<li role="option" aria-selected={i === active}>
					<button type="button" class={cn('flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted', i === active && 'bg-muted')}
						onmousedown={(e) => e.preventDefault()} onclick={() => choose(hit)}>
						<Icon icon="lucide:map-pin" class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
						<span class="min-w-0">{hit.address}</span>
					</button>
				</li>
			{/each}
		</ul>
	{:else if failed}
		<p class="text-xs text-muted-foreground">{t('addressSearchUnavailable')}</p>
	{/if}
	{#if point !== null}<p class="text-meta tabular-nums">{formatPoint(point)}</p>{/if}
	{#if locateError}<p class="text-xs text-muted-foreground">{t('locationDenied')}</p>{/if}
</div>
