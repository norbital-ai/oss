<!--
	A resizable preview web view, the only place a preview shows (it is never a destination of its own). One compact
	header: what it previews, a running build's status, the device (Phone, Tablet, Desktop as icons), the caller's details
	(ⓘ) and actions (…), Reload. Below, the page sits in a device bezel on a blueprint grid, so it never reads as part of
	the app around it. The page always lays out at the chosen size in its own CSS pixels — a desktop is a desktop even in
	a narrow pane — and is scaled down to fit, as a browser's device mode does (width × height · zoom, in the corner). Its
	right and bottom edges drag to any size. A new build (`version`) reloads it; the sandbox keeps it from navigating the
	page around it; the last size is remembered on this device, but a phone always opens at Phone, without the device
	buttons, and under a coarse pointer the header wraps. Studio's preview pane and the agent panel both use it.
-->
<script lang="ts">
	import { everySecond } from '../seconds.ts';
	import { Button, Icon, Popover, Spinner, TabStrip } from '@norbital-ai/ui';
	import { Cluster, Inline, Stack } from '@norbital-ai/ui/layout';
	import { Option, Schema } from 'effect';
	import { watch } from 'runed';
	import type { Snippet } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { elapsed_text } from '../studio/model.ts';
	import type { StudioTestRun } from '../studio/test-results.ts';
	import TestResults from './TestResults.svelte';

	let {
		src,
		tests,
		title = 'Preview',
		label,
		version,
		status,
		details,
		menu,
		on_close,
		t = (key: string) => key
	}: {
		src: string | null;
		tests?: StudioTestRun | undefined;
		title?: string;
		/** What it previews (a draft, a commit): the header reads "Preview · <label>". */
		label?: string | undefined;
		/** The build it shows: a new one reloads the frame at the same address. */
		version?: string | undefined;
		/** A running build ("Building… · 0:05"): shown beside the label with a spinner. */
		status?: string | undefined;
		/** What the preview runs (data, build, expiry): behind ⓘ. */
		details?: Snippet;
		/** The caller's actions (rebuild, live data, exit): behind …; each receives a closer for the menu. */
		menu?: Snippet<[() => void]>;
		on_close?: () => void;
		t?: (key: string) => string;
	} = $props();

	let pane = $state('preview');
	$effect(() => {
		if (src === null) pane = 'tests';
	});
	const testColor = $derived(
		tests?.state === 'running'
			? 'text-info'
			: tests?.state === 'passed'
				? 'text-success'
				: tests?.state === 'failed'
					? 'text-destructive'
					: 'text-muted-foreground'
	);
	const Size = Schema.Struct({ width: Schema.Number, height: Schema.Number });
	type Size = typeof Size.Type;
	const KEY = 'norbital.preview.size';
	const MIN = 240;
	const PRESETS = [
		{ name: 'Phone', icon: 'lucide:smartphone', size: { width: 390, height: 844 } },
		{ name: 'Tablet', icon: 'lucide:tablet', size: { width: 820, height: 1180 } },
		{ name: 'Desktop', icon: 'lucide:monitor', size: { width: 1440, height: 900 } }
	] as const;
	const DESKTOP: Size = PRESETS[2].size;

	function remembered(): Size {
		try {
			const raw = localStorage.getItem(KEY);
			return raw === null
				? DESKTOP
				: Option.getOrElse(
						Schema.decodeUnknownOption(Schema.fromJsonString(Size))(raw),
						() => DESKTOP
					);
		} catch {
			return DESKTOP;
		}
	}
	function remember(next: Size): void {
		try {
			localStorage.setItem(KEY, JSON.stringify(next));
		} catch {
			// storage unavailable (a private window): the size lasts for this page only
		}
	}

	const narrow = new MediaQuery('max-width: 47.999rem');
	const touch = new MediaQuery('pointer: coarse');
	// a 44px thumb floor overruns one line; a mouse keeps the line and truncates the label
	const Row = $derived(touch.current ? Cluster : Inline);
	// a phone has no device buttons to leave a remembered desktop size with
	let size = $state<Size>(narrow.current ? PRESETS[0].size : remembered());
	let frame = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);
	let reloads = $state(0);
	// the frame's own load: a spinner over it until this address and build have loaded, so it never looks stuck
	const loading = $derived(`${reloads}:${version ?? ''}:${src}`);
	let loaded = $state('');
	// while it loads: how long it has taken, and why it could not load when the address answers with an error
	let since = $state(Date.now()),
		now = $state(Date.now()),
		failure = $state<string | null>(null);
	watch(
		() => loading,
		(key) => {
			since = now = Date.now();
			failure = null;
			if (src === null) return;
			const stopClock = everySecond((at) => (now = at));
			let retry: ReturnType<typeof setTimeout> | undefined;
			// the address itself: an error status is a reason to show, except a busy host (503), which is waited out
			// with the loading card up; a redirect (the hand-off) or a cross-origin address answers nothing readable
			void fetch(src, { redirect: 'manual', credentials: 'include' }).then(
				(response) => {
					if (key !== loading) return;
					if (response.status === 503) retry = setTimeout(() => reloads++, 5_000);
					else if (response.status >= 400)
						failure = `${response.status} ${response.statusText}`.trim();
				},
				() => {}
			);
			return () => {
				stopClock();
				clearTimeout(retry);
			};
		}
	);
	const waiting = $derived(loaded !== loading);
	let menuOpen = $state(false);
	// the room the frame has; the page keeps its size and is drawn at `zoom` to fit it
	let roomWidth = $state(0),
		roomHeight = $state(0);
	const zoom = $derived(
		roomWidth === 0 || roomHeight === 0
			? 1
			: Math.min(1, roomWidth / size.width, roomHeight / size.height)
	);

	function choose(next: Size): void {
		size = next;
		remember(next);
	}
	/** Drags the frame's right edge (`x`), bottom edge (`y`) or corner (`xy`) from where the pointer went down. */
	function resize(axis: 'x' | 'y' | 'xy', down: PointerEvent): void {
		if (frame === null) return;
		const handle = down.currentTarget;
		if (!(handle instanceof HTMLElement)) return;
		const start = {
			x: down.clientX,
			y: down.clientY,
			width: size.width,
			height: size.height,
			zoom
		};
		handle.setPointerCapture(down.pointerId);
		dragging = true;
		const move = (event: PointerEvent) => {
			size = {
				width: Math.round(
					Math.max(
						MIN,
						axis === 'y' ? start.width : start.width + (event.clientX - start.x) / start.zoom
					)
				),
				height: Math.round(
					Math.max(
						MIN,
						axis === 'x' ? start.height : start.height + (event.clientY - start.y) / start.zoom
					)
				)
			};
		};
		const up = () => {
			dragging = false;
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			handle.removeEventListener('pointercancel', up);
			remember(size);
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
		handle.addEventListener('pointercancel', up);
	}
	// the room's padding and the bezel around the page: what the scaled page cannot use
	const BEZEL = 24 + 14;
	// Svelte Flow's dotted canvas: a 1px dot every 20px on the page's own background
	const GRID =
		'radial-gradient(circle, color-mix(in oklab, var(--color-muted-foreground) 45%, transparent) 1px, transparent 1px)';
	const HANDLE = 'absolute touch-none bg-border/0 transition-colors hover:bg-primary/30';
</script>

<Stack gap="none" size="fill">
	<TabStrip
		class="px-4"
		label={t('Preview panels')}
		value={pane}
		on_value_change={(value) => (pane = value)}
		items={[
			{ name: 'preview', title: t('Preview'), icon: 'lucide:monitor' },
			{
				name: 'tests',
				title:
					tests === undefined
						? t('Tests')
						: `${t('Tests')} · ${t(tests.state === 'running' ? 'Running' : tests.state === 'passed' ? 'Passed' : tests.state === 'failed' ? 'Failed' : 'Empty')}`,
				icon: 'lucide:flask-conical',
				icon_class: testColor
			}
		]}
	/>
	<Row
		gap="xs"
		class="min-h-9 border-b border-border/60 px-4 text-micro text-muted-foreground pointer-coarse:min-h-11"
	>
		<strong class="min-w-0 truncate text-xs font-medium text-foreground"
			>{label ?? t('Preview')}</strong
		>
		{#if pane === 'preview'}
			{#if status !== undefined}
				<span role="status" class="inline-flex shrink-0 items-center gap-1 text-foreground"
					><Spinner class="size-3" />{status}</span
				>
			{/if}
			<span class="flex-1"></span>
			{#if !narrow.current}
				<span
					class="inline-flex shrink-0 rounded-md bg-muted/60 p-0.5"
					role="group"
					aria-label={t('Device')}
				>
					{#each PRESETS as preset (preset.name)}
						{@const on = size.width === preset.size.width && size.height === preset.size.height}
						<button
							type="button"
							class="grid size-6 place-items-center rounded {on
								? 'bg-background text-foreground shadow-xs'
								: 'hover:text-foreground'}"
							aria-pressed={on}
							aria-label={t(preset.name)}
							title={t(preset.name)}
							onclick={() => choose({ ...preset.size })}
						>
							<Icon name={preset.icon} class="size-3.5" />
						</button>
					{/each}
				</span>
			{/if}
			{#if details !== undefined}
				<Popover.Root>
					<Popover.Trigger
						class="grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground"
						aria-label={t('Details')}
						title={t('Details')}
					>
						<Icon name="lucide:info" class="size-3.5" />
					</Popover.Trigger>
					<Popover.Content align="end" class="w-72 p-3 text-micro text-muted-foreground"
						>{@render details()}</Popover.Content
					>
				</Popover.Root>
			{/if}
			{#if menu !== undefined}
				<Popover.Root bind:open={menuOpen}>
					<Popover.Trigger
						class="grid size-7 shrink-0 place-items-center rounded-md hover:bg-accent hover:text-foreground"
						aria-label={t('More')}
						title={t('More')}
					>
						<Icon name="lucide:ellipsis" class="size-3.5" />
					</Popover.Trigger>
					<Popover.Content align="end" class="grid w-56 gap-0.5 p-1"
						>{@render menu(() => (menuOpen = false))}</Popover.Content
					>
				</Popover.Root>
			{/if}
			<Button
				variant="ghost"
				class="size-7 shrink-0 p-0"
				aria-label={t('Reload')}
				title={t('Reload')}
				onclick={() => reloads++}
			>
				<Icon name="lucide:rotate-cw" class="size-3.5" />
			</Button>
		{:else}<span class="flex-1"></span>{/if}
		{#if on_close !== undefined}
			<Button
				variant="ghost"
				class="size-7 shrink-0 p-0"
				aria-label={t('Close preview')}
				title={t('Close preview')}
				onclick={on_close}
				data-preview-close
			>
				<Icon name="lucide:x" class="size-3.5" />
			</Button>
		{/if}
	</Row>
	{#if pane === 'tests'}<TestResults run={tests} {t} />{/if}
	<div
		class={pane === 'preview' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
		aria-hidden={pane !== 'preview'}
	>
		{#if src === null}
			<p class="grid min-h-40 flex-1 place-items-center p-4 text-xs text-muted-foreground">
				{t('Build a preview to view the app.')}
			</p>
		{:else}
			<!-- a canvas: the page is a device on a dotted canvas, never part of the app around it -->
			<div
				class="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-background p-3"
				style:background-image={GRID}
				style:background-size="20px 20px"
				bind:clientWidth={
					null, (w: number | null | undefined) => (roomWidth = Math.max(0, (w ?? 0) - BEZEL))
				}
				bind:clientHeight={
					null, (h: number | null | undefined) => (roomHeight = Math.max(0, (h ?? 0) - BEZEL))
				}
			>
				<!-- the bezel; inside it the box is the scaled size, the page laid out at the full size and drawn at `zoom` -->
				<div
					class="relative mx-auto w-fit rounded-2xl border border-border bg-card p-1.5 shadow-deep"
				>
					<div
						bind:this={frame}
						class="relative overflow-hidden rounded-xl bg-background ring-1 ring-border/60"
						style:width={`${size.width * zoom}px`}
						style:height={`${size.height * zoom}px`}
					>
						{#key loading}
							<iframe
								{title}
								{src}
								onload={() => (loaded = loading)}
								sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
								class="origin-top-left border-0 bg-background {dragging
									? 'pointer-events-none'
									: ''}"
								style:width={`${size.width}px`}
								style:height={`${size.height}px`}
								style:transform={zoom < 1 ? `scale(${zoom})` : undefined}
							></iframe>
						{/key}
						{#if waiting || failure !== null}
							<!-- never a blank frame: a calm card over the canvas says what is happening, or why it failed -->
							<div
								class="absolute inset-0 grid place-items-center bg-background p-4"
								style:background-image={GRID}
								style:background-size="20px 20px"
								role="status"
								data-preview-loading={failure === null || undefined}
								data-preview-failed={failure !== null || undefined}
							>
								<Stack
									gap="xs"
									align="center"
									class="max-w-64 rounded-lg border border-border bg-card px-4 py-3 text-center shadow-xs"
								>
									{#if failure === null}
										<Spinner class="size-4" />
										<p class="text-sm font-medium text-foreground">{t('Starting the preview…')}</p>
										<p class="text-meta">
											{label ?? t('Preview')} · {elapsed_text(now - since)}
										</p>
									{:else}
										<Icon name="lucide:circle-alert" class="size-4 text-destructive" />
										<p class="text-sm font-medium text-foreground">
											{t('The preview could not load')}
										</p>
										<p class="text-meta">{failure}</p>
										<Button variant="outline" onclick={() => reloads++}>{t('Retry')}</Button>
									{/if}
								</Stack>
							</div>
						{/if}
					</div>
					<!-- the bezel's edges drag with a pointer; the device buttons above are the keyboard path -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						aria-hidden="true"
						class="{HANDLE} top-0 -right-1 h-full w-2 cursor-ew-resize"
						onpointerdown={(event) => resize('x', event)}
					></span>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						aria-hidden="true"
						class="{HANDLE} -bottom-1 left-0 h-2 w-full cursor-ns-resize"
						onpointerdown={(event) => resize('y', event)}
					></span>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						aria-hidden="true"
						class="{HANDLE} -right-1 -bottom-1 size-3 cursor-nwse-resize"
						onpointerdown={(event) => resize('xy', event)}
					></span>
				</div>
				<span
					class="absolute right-2 bottom-1 font-mono text-micro text-muted-foreground tabular-nums"
					aria-live="polite"
					>{size.width} × {size.height}{#if zoom < 1}
						· {Math.round(zoom * 100)}%{/if}</span
				>
			</div>
		{/if}
	</div>
</Stack>
