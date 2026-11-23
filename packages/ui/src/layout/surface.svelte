<!--
@component
A semantic surface container (`card`, `subtle`, `muted`, `lane`, `popover`, `transparent`) with
standardized hairline border, corner geometry (`control` 6px, `overlay` 12px, `inset` 4px) and
spacing — eliminating raw Tailwind border/radius/dark: utility soup in tenant pages.
@example
<Surface tone="card" padding="md" radius="control">
	<Stack gap="sm">...</Stack>
</Surface>
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	/** Semantic surface fill role. */
	export type SurfaceTone = 'card' | 'subtle' | 'muted' | 'lane' | 'popover' | 'transparent';
	/** Inner padding scale for `Surface`. */
	export type SurfacePadding = 'none' | 'xs' | 'sm' | 'md' | 'lg';
	/** Corner geometry role for `Surface`. */
	export type SurfaceRadius = 'control' | 'overlay' | 'inset' | 'none';

	/** Props accepted by `Surface`. */
	export type SurfaceProps = HTMLAttributes<HTMLElement> & {
		/** Semantic surface fill (default `'card'`). */
		tone?: SurfaceTone;
		/** Inner padding scale (default `'md'`). */
		padding?: SurfacePadding;
		/** Corner geometry token (default `'control'` — 6px). */
		radius?: SurfaceRadius;
		/** Hairline semantic border (default `true`). */
		bordered?: boolean;
		/** Subtle hover highlight for clickable/interactive surfaces (default `false`). */
		interactive?: boolean;
		/** Underlying HTML element (default `'div'`). */
		as?: 'div' | 'section' | 'article' | 'aside' | 'li' | 'header' | 'footer';
		/** Inner surface content. */
		children?: Snippet;
	};

	const TONE: Record<SurfaceTone, string> = {
		card: 'bg-surface-card text-card-foreground',
		subtle: 'bg-surface-subtle text-foreground',
		muted: 'bg-surface-muted text-foreground',
		lane: 'bg-surface-lane text-foreground',
		popover: 'bg-surface-popover text-popover-foreground',
		transparent: 'bg-transparent text-foreground'
	};

	const PADDING: Record<SurfacePadding, string> = {
		none: '',
		xs: 'p-2',
		sm: 'p-3',
		md: 'p-4',
		lg: 'p-6'
	};

	const RADIUS: Record<SurfaceRadius, string> = {
		control: 'rounded-control',
		overlay: 'rounded-overlay',
		inset: 'rounded-inset',
		none: 'rounded-none'
	};
</script>

<script lang="ts">
	import { cn } from '../primitives/utils.js';

	let {
		tone = 'card',
		padding = 'md',
		radius = 'control',
		bordered = true,
		interactive = false,
		as = 'div',
		class: className,
		children,
		...rest
	}: SurfaceProps = $props();
</script>

<svelte:element
	this={as}
	data-surface={tone}
	class={cn(
		TONE[tone],
		PADDING[padding],
		RADIUS[radius],
		bordered && 'border border-border',
		interactive && 'transition-colors hover:bg-surface-hover',
		className
	)}
	{...rest}
>
	{@render children?.()}
</svelte:element>
