<script lang="ts" module>
	import type { Dialog, WithoutChildrenOrChild } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import type { Side } from './sheet-variants.js';

	export interface SheetContentProps extends WithoutChildrenOrChild<Dialog.ContentProps> {
		side?: Side;
		children: Snippet;
		fullScreen?: boolean;
		/** Drop default padding/gap so embedded surfaces (e.g. sandbox iframe) can be edge-to-edge. */
		flush?: boolean;
		/** Position the sheet relative to its portal container instead of the viewport. */
		contained?: boolean;
		preventBackgroundClick?: boolean;
		actions?: Snippet[];
		persistenceKey?: string;
		portalTarget?: string;
		showCloseButton?: boolean;
	}
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { cn, RenderComponentConfig, RenderSnippetConfig } from '#lib/utils';
	import { Dialog as BitsDialog } from 'bits-ui';
	import { PersistedState } from 'runed';
	import { onMount } from 'svelte';
	import SheetContentResize from './sheet-content-resize.svelte';
	import { resolveSheetPortalTarget } from './sheet-portal-target.js';
	import { sheetVariants } from './sheet-variants.js';
	const SheetPortal = BitsDialog.Portal;

	let {
		ref = $bindable<HTMLElement | null>(null),
		class: className,
		side = 'right' as const,
		children,
		fullScreen = $bindable(false),
		flush = false,
		contained = false,
		preventBackgroundClick = true,
		actions = [] as Snippet[],
		persistenceKey,
		portalTarget,
		showCloseButton = true,
		onOpenAutoFocus,
		...restProps
	}: SheetContentProps = $props();

	function handleOpenAutoFocus(event: Event): void {
		// Sheets open from row actions. Preventing autofocus alone is not enough: with
		// trapFocus, focus outside the sheet is pulled back onto the first tabbable
		// (detail "UI" tab), which opens its tooltip. Park focus on the sheet container.
		onOpenAutoFocus?.(event);
		event.preventDefault();
		queueMicrotask(() => {
			if (!ref) return;
			if (ref.contains(document.activeElement)) return;
			ref.focus({ preventScroll: true });
		});
	}

	let mountedPortalTarget = $state<Element | null>(null);

	onMount(() => {
		mountedPortalTarget = resolveSheetPortalTarget(portalTarget, document) ?? document.body;
	});

	class MemoryState<T> {
		current = $state() as T;

		constructor(initialValue: T) {
			this.current = initialValue;
		}
	}

	type WidthState = PersistedState<number | null> | { current: number | null };

	function canUseSessionStorage(): boolean {
		try {
			void window.sessionStorage;
			return true;
		} catch {
			return false;
		}
	}

	function createSheetWidthState(key: string): WidthState {
		if (canUseSessionStorage()) {
			return new PersistedState<number | null>(key, null, { storage: 'session' });
		}
		return new MemoryState<number | null>(null);
	}

	const persistedWidth = $derived<WidthState | null>(
		persistenceKey ? createSheetWidthState(persistenceKey) : null
	);

	// Height is always tracked so mobile bottom-sheet drags stick even without persistenceKey.
	// Persistence identity is fixed for the lifetime of a mounted sheet.
	// svelte-ignore state_referenced_locally
	const heightState: WidthState = persistenceKey
		? createSheetWidthState(`${persistenceKey}-height`)
		: new MemoryState<number | null>(null);

	const mobileBottomSheet = $derived(!fullScreen && (side === 'left' || side === 'right'));

	type Dim = {
		width: string | null;
		maxWidth: string | null;
		height: string | null;
		absoluteFullscreen: boolean;
	};

	/**
	 * We deliberately delegate "size follows available space" to the
	 * browser's layout engine instead of recomputing pixel widths in JS.
	 *
	 * Any CSS length expressed as a percentage (or `%`-derived unit like
	 * `calc(...%)`) is resolved against the containing block on every
	 * layout pass, so a viewport resize, workspace-inset reflow, or the
	 * sidebar opening/closing just flows through — no `ResizeObserver`,
	 * no `window.resize` listener, no Svelte derived to invalidate.
	 *
	 * Fullscreen:
	 *   `width: 100%` + `max-width: 100%` overrides the `w-3/4` /
	 *   `sm:max-w-sm` baked into `sheetVariants` so the sheet fills its
	 *   positioned ancestor (the portal target for contained, the
	 *   viewport for fixed).
	 *
	 * Non-fullscreen:
	 *   `max-width: 90%` keeps the sheet at most 90% of the container.
	 *   When the user has drag-resized the sheet, `persistedWidth.current`
	 *   is a pixel width — we still emit it, but the `max-width: 90%`
	 *   naturally clamps it when the container shrinks below 111% of that
	 *   pixel value. Growing the container just lifts the clamp, again
	 *   with zero JS. The `onResize` handler below does a point-in-time
	 *   pixel calc (no reactivity needed there — it only fires during a
	 *   drag).
	 */
	const dimensionInfo = $derived.by<Dim>(() => {
		if (fullScreen) {
			return {
				width: '100%',
				maxWidth: '100%',
				height: '100%',
				absoluteFullscreen: true
			};
		}

		const widthPx = persistedWidth?.current ?? null;
		const heightPx = heightState.current;
		return {
			width: widthPx ? `${widthPx}px` : null,
			maxWidth: '90%',
			height: heightPx ? `${heightPx}px` : null,
			absoluteFullscreen: false
		};
	});

	const inlineStyles = $derived.by<string>(() => {
		const { width, maxWidth, height, absoluteFullscreen } = dimensionInfo;
		let s = '';
		if (width) s += `--sheet-width:${width};`;
		if (maxWidth) s += `--sheet-max-width:${maxWidth};`;
		if (height) s += `--sheet-height:${height};`;
		if (absoluteFullscreen)
			s += `position:absolute;inset:0;width:100%;max-width:100%;height:100%;max-height:100%;margin:0;border-radius:0;box-sizing:border-box;`;
		return s;
	});

	const shouldShowActions = $derived(actions.length > 0);
	const shouldShowCloseButton = $derived(showCloseButton && !fullScreen);

	const contentClasses = $derived(
		cn(
			'sheet-content flex h-full max-h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden outline-none',
			sheetVariants({ side }),
			contained ? 'absolute' : 'fixed',
			fullScreen ? 'inset-0' : '',
			flush ? 'gap-0 p-0 shadow-none sm:max-w-none' : '',
			className,
			{
				'shadow-none border-none': fullScreen
			}
		)
	);
</script>

{#if mountedPortalTarget}
	<SheetPortal to={mountedPortalTarget}>
		<BitsDialog.Content
			preventScroll={mobileBottomSheet}
			bind:ref
			data-sheet-side={side}
			data-mobile-bottom-sheet={mobileBottomSheet}
			data-fullscreen={fullScreen}
			class={contentClasses}
			style={inlineStyles}
			{...restProps}
			onOpenAutoFocus={handleOpenAutoFocus}
		>
			{#if ref && !fullScreen}
				<SheetContentResize
					{ref}
					{side}
					{contained}
					{mobileBottomSheet}
					onResize={() => {
						if (!persistedWidth || !ref) return;
						// Clamp the persisted pixel value to 90% of whichever
						// container constrains the sheet *right now*. This is a
						// point-in-time read during an active drag — we don't need
						// a reactive signal here because the CSS `max-width: 90%`
						// rule (see `dimensionInfo`) is what keeps the rendered
						// width in sync on subsequent container resizes. Persisting
						// the clamped value just avoids writing a number larger
						// than what the user actually sees after the drag.
						const container = contained
							? (ref.parentElement?.clientWidth ?? window.innerWidth)
							: window.innerWidth;
						const maxPartialWidth = Math.floor(container * 0.9);
						persistedWidth.current = Math.min(ref.offsetWidth, maxPartialWidth);
					}}
					onHeightChange={(height) => {
						heightState.current = height;
					}}
				/>
			{/if}

			{#if shouldShowActions}
				<section
					class="relative flex w-full shrink-0 flex-row items-center space-x-2 overflow-hidden"
				>
					{#each actions as action (action)}
						{#if action instanceof RenderComponentConfig}
							{@const { component: Component, props } = action}
							<Component {...props} />
						{:else if action instanceof RenderSnippetConfig}
							{@const { snippet, params } = action}
							{@render snippet(params)}
						{:else}
							{@render action()}
						{/if}
					{/each}
				</section>
			{/if}

			{@render children()}

			{#if shouldShowCloseButton}
				<BitsDialog.Close
					class="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none data-[state=open]:bg-secondary"
				>
					<Icon icon="lucide:x" class="size-4" />
					<span class="sr-only">Close</span>
				</BitsDialog.Close>
			{/if}
		</BitsDialog.Content>
	</SheetPortal>
{/if}
