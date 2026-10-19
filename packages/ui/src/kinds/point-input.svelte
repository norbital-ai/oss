<!--
@component
Edits a `point`: a compact trigger opens address suggestions and the map. Typed coordinates, a map click or marker drag,
and the browser's location also set the point.
-->
<script lang="ts" module>
	import type { Value, Point } from './kind.js';

	/**
	 * A `point` field (P19, rule 69). Typing an address geocodes it (the host's geocoder, else the keyless default) and the
	 * map and value follow the best match; typed "lat, lng" is taken as is. A pick on the map, a marker drag or "use my
	 * location" set the point and look up its address. `address` is the sibling text field's value, shown in the trigger;
	 * `onAddress` receives what the box holds (`Field address="<field>"` wires both).
	 */
	export type PointInputProps = {
		value: Value;
		onChange(next: Point | null): void;
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
	import { Effect, FiberHandle } from 'effect';
	import { attach, fork } from '../effect/index.js';
	import Input from '../primitives/input/input.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { CONTROL } from './classes.js';
	import { cn, uiText } from '../primitives/utils.js';
	import { photonGeocoder, regionOf, useKinds, type Geocoder } from './context.js';
	import { formatPoint, isPoint, parsePoint } from './kind.js';
	import PointMap from './point-map.svelte';

	let {
		value,
		onChange,
		address = null,
		onAddress,
		id,
		disabled = false,
		invalid = false,
		map = true
	}: PointInputProps = $props();
	const host = useKinds();
	const geocoder: Geocoder = host.geocoder ?? photonGeocoder;
	const t = uiText();
	const uid = $props.id();
	const point = $derived(((v) => (isPoint(v) ? v : null))(value));

	type Hit = { point: Point; address: string };
	let text = $state(''),
		open = $state(false),
		looked = $state<string | null>(null);
	let hits = $state<readonly Hit[]>([]),
		active = $state(0),
		searching = $state(false),
		failed = $state(false);
	// the trigger shows the stored address, else the address last looked up for the point, else its coordinates
	const shown = $derived(address ?? looked ?? (point === null ? '' : formatPoint(point)));

	let requests: FiberHandle.FiberHandle | undefined,
		asked = 0;
	const lifetime = attach(() =>
		Effect.gen(function* () {
			requests = yield* FiberHandle.make();
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					requests = undefined;
					asked++;
				})
			);
			yield* Effect.never;
		})
	);
	const start = (work: Effect.Effect<unknown>) => {
		if (requests !== undefined) fork(FiberHandle.run(requests, work));
	};
	const reverse = (point: Point) =>
		geocoder
			.reverse?.(point)
			.pipe(Effect.catch((error) => Effect.logWarning(error).pipe(Effect.as(null)))) ??
		Effect.succeed(null);
	function typed(q: string) {
		text = q;
		looked = null;
		hits = [];
		searching = false;
		const n = ++asked;
		const at = parsePoint(q);
		if (at !== null) {
			onChange(at);
			onAddress?.(null);
			start(
				Effect.sleep(600).pipe(
					Effect.flatMap(() => reverse(at)),
					Effect.tap((name) =>
						Effect.sync(() => {
							if (n === asked && name) {
								looked = name;
								onAddress?.(name);
							}
						})
					)
				)
			);
			return;
		}
		onAddress?.(q.trim() === '' ? null : q);
		if (q.trim() === '') {
			onChange(null);
			start(Effect.void);
			return;
		}
		if (q.trim().length < 3) {
			start(Effect.void);
			return;
		}
		start(
			Effect.sleep(350).pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						searching = true;
					})
				),
				Effect.flatMap(() => {
					const region = regionOf(host.locale);
					return geocoder.search(q.trim(), region === undefined ? {} : { region });
				}),
				Effect.tap((found) =>
					Effect.sync(() => {
						if (n !== asked) return;
						hits = [...found.slice(0, 5)];
						failed = false;
						active = 0;
						if (hits[0] !== undefined) onChange(hits[0].point);
					})
				),
				Effect.catch(() =>
					Effect.sync(() => {
						if (n === asked) {
							hits = [];
							failed = true;
						}
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						if (n === asked) searching = false;
					})
				)
			)
		);
	}
	function preview(i: number) {
		active = i;
		if (hits[i]) onChange(hits[i].point);
	}
	function choose(hit: Hit) {
		asked++;
		hits = [];
		text = hit.address;
		onChange(hit.point);
		onAddress?.(hit.address);
		looked = hit.address;
		open = false;
	}
	/** A point from the map or the device: set it, then name it when the geocoder can. */
	function set(p: Point) {
		const n = ++asked;
		hits = [];
		onChange(p);
		looked = null;
		text = formatPoint(p);
		start(
			reverse(p).pipe(
				Effect.tap((name) =>
					Effect.sync(() => {
						if (n !== asked || !name) return;
						looked = text = name;
						onAddress?.(name);
					})
				)
			)
		);
	}
	function keys(e: KeyboardEvent) {
		if (hits.length === 0) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			preview((active + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const hit = hits[active];
			if (hit !== undefined) choose(hit);
		} else if (e.key === 'Escape') hits = [];
	}

	const canLocate = typeof navigator !== 'undefined' && 'geolocation' in navigator;
	let locating = $state(false),
		locateError = $state(false);
	function locate() {
		locating = true;
		locateError = false;
		const location = Effect.callback<Point, GeolocationPositionError>((resume) => {
			let cancelled = false;
			navigator.geolocation.getCurrentPosition(
				(position) => {
					if (!cancelled)
						resume(
							Effect.succeed({
								lat: Number(position.coords.latitude.toFixed(6)),
								lng: Number(position.coords.longitude.toFixed(6))
							})
						);
				},
				(error) => {
					if (!cancelled) resume(Effect.fail(error));
				},
				{ enableHighAccuracy: true, timeout: 15_000 }
			);
			return Effect.sync(() => {
				cancelled = true;
			});
		});
		start(
			location.pipe(
				Effect.tap((point) => Effect.sync(() => set(point))),
				Effect.catch(() =>
					Effect.sync(() => {
						locateError = true;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						locating = false;
					})
				)
			)
		);
	}
</script>

<div class="contents" {@attach lifetime}>
	<Popover.Root bind:open>
		<Popover.Trigger
			{id}
			{disabled}
			aria-invalid={invalid ? 'true' : undefined}
			data-point-picker
			onclick={() => {
				text = shown;
				hits = [];
			}}
			class={cn(
				CONTROL,
				'flex w-full min-w-0 items-center gap-2 text-left font-normal',
				!shown && 'text-muted-foreground'
			)}
		>
			<Icon icon="lucide:map-pin" class="size-4 shrink-0 text-muted-foreground" />
			<span class="min-w-0 flex-1 truncate">{shown || t('searchAddress')}</span>
			<Icon icon="lucide:chevrons-up-down" class="size-4 shrink-0 text-muted-foreground" />
		</Popover.Trigger>
		<Popover.Content
			align="start"
			class="grid w-[min(30rem,calc(100vw-1rem))] gap-2 p-2"
			data-point-options
		>
			<div class="flex items-center gap-2">
				<div class="relative min-w-0 flex-1">
					<Icon
						icon={searching ? 'lucide:loader-circle' : 'lucide:search'}
						class={cn(
							'pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground',
							searching && 'animate-spin'
						)}
					/>
					<Input
						value={text}
						oninput={(e) => typed(e.currentTarget.value)}
						onkeydown={keys}
						placeholder={t('searchAddress')}
						autocomplete="off"
						role="combobox"
						aria-expanded={hits.length > 0}
						aria-controls={`${uid}-places`}
						class="pl-8"
						{disabled}
					/>
				</div>
				{#if canLocate}
					<button
						type="button"
						class="border-input hover:bg-accent grid size-9 shrink-0 place-items-center rounded-md border"
						onclick={locate}
						disabled={disabled || locating}
						aria-label={t('useMyLocation')}
						title={t('useMyLocation')}
					>
						<Icon
							icon={locating ? 'lucide:loader-circle' : 'lucide:locate-fixed'}
							class={cn('size-4', locating && 'animate-spin')}
						/>
					</button>
				{/if}
			</div>
			{#if hits.length > 0}
				<ul
					id={`${uid}-places`}
					class="grid max-h-40 gap-0.5 overflow-auto rounded-md border p-1"
					role="listbox"
					data-point-suggestions
				>
					{#each hits as hit, i (`${hit.point.lat},${hit.point.lng},${hit.address}`)}
						<li role="option" aria-selected={i === active}>
							<button
								type="button"
								class={cn(
									'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted',
									i === active && 'bg-muted'
								)}
								onmousedown={(e) => e.preventDefault()}
								onclick={() => choose(hit)}
							>
								<Icon
									icon="lucide:map-pin"
									class="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
								/>
								<span class="min-w-0">{hit.address}</span>
							</button>
						</li>
					{/each}
				</ul>
			{:else if failed}<p class="text-xs text-muted-foreground">
					{t('addressSearchUnavailable')}
				</p>{/if}
			{#if map}<PointMap value={point} onPick={set} {disabled} class="h-48 sm:h-56" />{/if}
			{#if point !== null}<p class="text-meta tabular-nums">{formatPoint(point)}</p>{/if}
			{#if locateError}<p class="text-xs text-muted-foreground">{t('locationDenied')}</p>{/if}
		</Popover.Content>
	</Popover.Root>
</div>
