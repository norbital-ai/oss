<!--
	A resizable preview web view, the only place a preview shows (it is never a destination of its own): a header naming
	it ("Preview · <label>"), device sizes (Phone, Tablet, Desktop fills the pane), the frame's right and bottom edges drag
	to any size (shown as width × height), and Reload. The page inside is the real page at its own CSS pixels, so it lays
	out exactly as in a browser of that size; the sandbox keeps it from navigating the page around it. The last size is
	remembered on this device. Studio's preview pane and the agent panel both use it.
-->
<script lang="ts">
	import { Button, Icon } from '@norbital-ai/ui';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { Option, Schema } from 'effect';

	let {
		src,
		title = 'Preview',
		label,
		onClose,
		t = (key: string) => key
	}: {
		src: string;
		title?: string;
		/** What it previews (a draft, a commit): the header reads "Preview · <label>". */
		label?: string;
		onClose?: () => void;
		t?: (key: string) => string;
	} = $props();

	/** `null`: the frame fills the pane (Desktop). */
	const Size = Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number }));
	type Size = typeof Size.Type;
	const KEY = 'norbital.preview.size';
	const MIN = 240;
	const PRESETS = [
		{ name: 'Phone', icon: 'lucide:smartphone', size: { width: 390, height: 844 } },
		{ name: 'Tablet', icon: 'lucide:tablet', size: { width: 820, height: 1180 } },
		{ name: 'Desktop', icon: 'lucide:monitor', size: null }
	] as const;

	function remembered(): Size {
		try {
			const raw = localStorage.getItem(KEY);
			return raw === null
				? null
				: Option.getOrNull(Schema.decodeUnknownOption(Schema.fromJsonString(Size))(raw));
		} catch {
			return null;
		}
	}
	function remember(next: Size): void {
		try {
			localStorage.setItem(KEY, JSON.stringify(next));
		} catch {
			// storage unavailable (a private window): the size lasts for this page only
		}
	}

	let size = $state<Size>(remembered());
	let frame = $state<HTMLDivElement | null>(null);
	let dragging = $state(false);
	let reloads = $state(0);

	function choose(next: Size): void {
		size = next;
		remember(next);
	}
	/** Drags the frame's right edge (`x`), bottom edge (`y`) or corner (`xy`) from where the pointer went down. */
	function resize(axis: 'x' | 'y' | 'xy', down: PointerEvent): void {
		if (frame === null) return;
		const handle = down.currentTarget;
		if (!(handle instanceof HTMLElement)) return;
		const box = frame.getBoundingClientRect(),
			start = { x: down.clientX, y: down.clientY, width: box.width, height: box.height };
		handle.setPointerCapture(down.pointerId);
		dragging = true;
		const move = (event: PointerEvent) => {
			size = {
				width: Math.round(
					Math.max(MIN, axis === 'y' ? start.width : start.width + event.clientX - start.x)
				),
				height: Math.round(
					Math.max(MIN, axis === 'x' ? start.height : start.height + event.clientY - start.y)
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
	const HANDLE = 'absolute touch-none bg-border/0 transition-colors hover:bg-primary/30';
</script>

<Stack gap="none" fill class="min-h-0">
	<Inline
		gap="xs"
		shrink={false}
		class="flex-wrap border-b border-border/60 px-2 py-1 text-micro text-muted-foreground"
	>
		<strong class="truncate px-1 font-medium text-foreground"
			>{t('Preview')}{#if label !== undefined}
				· {label}{/if}</strong
		>
		{#each PRESETS as preset (preset.name)}
			{@const on =
				preset.size === null
					? size === null
					: size !== null && size.width === preset.size.width && size.height === preset.size.height}
			<Button
				size="sm"
				variant={on ? 'secondary' : 'ghost'}
				class="px-2 text-micro"
				aria-pressed={on}
				onclick={() => choose(preset.size === null ? null : { ...preset.size })}
			>
				<Icon name={preset.icon} class="size-3.5" /><span class="hidden sm:inline"
					>{t(preset.name)}</span
				>
			</Button>
		{/each}
		<span class="px-1 font-mono tabular-nums" aria-live="polite"
			>{size === null ? t('Fills the pane') : `${size.width} × ${size.height}`}</span
		>
		<span class="flex-1"></span>
		<Button
			size="sm"
			variant="ghost"
			class="px-2 text-micro"
			aria-label={t('Reload')}
			title={t('Reload')}
			onclick={() => reloads++}
		>
			<Icon name="lucide:rotate-cw" class="size-3.5" />
		</Button>
		{#if onClose !== undefined}
			<Button
				size="sm"
				variant="ghost"
				class="px-2 text-micro"
				aria-label={t('Close preview')}
				title={t('Close preview')}
				onclick={onClose}
			>
				<Icon name="lucide:x" class="size-3.5" />
			</Button>
		{/if}
	</Inline>
	<div class="min-h-0 flex-1 overflow-auto bg-muted/40 {size === null ? '' : 'p-3'}">
		<div
			bind:this={frame}
			class="relative mx-auto bg-background {size === null
				? 'h-full w-full'
				: 'rounded-md border border-border shadow-sm'}"
			style:width={size === null ? undefined : `${size.width}px`}
			style:height={size === null ? undefined : `${size.height}px`}
		>
			{#key reloads}
				<iframe
					{title}
					{src}
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
					class="h-full w-full border-0 bg-background {dragging ? 'pointer-events-none' : ''}"
				></iframe>
			{/key}
			<!-- the edges drag with a pointer; the size buttons above are the keyboard path -->
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
	</div>
</Stack>
