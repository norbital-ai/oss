<!--
@component
One titled section of a form or record body: a heading row (title, an optional ⓘ hint, a mark, actions) over its content.
A titled section collapses from its heading; the body is hidden, never unmounted, so every field in it still saves.
Closed, the heading shows `summary` so nothing important is out of sight. The viewer's open state is remembered per
model and section; a section holding a field with an error opens itself.
A closed section is its heading alone. Open, `size` says how it takes height in a bounded column (a record body, a
`Stack` in a sheet): `content` (the default) is always its whole content, and the column scrolls when they do not
fit; `fill` (a table, a long list) shares the height left, scrolling inside itself, never below `minHeight` (default
its content or 16rem, whichever is less). Nothing scrolls sideways.
@example
<Section name="basis" title="Evidence basis" size="fill"><Table of="evidence" /></Section>
-->
<script lang="ts" module>
	import { getContext, type Snippet } from 'svelte';

	/** The props of `Section`. */
	export type SectionProps = {
		/** The heading. Without one the section is plain content, always open. */
		title?: string;
		/** One sentence saying what the section decides, behind an info icon beside the title. */
		hint?: string;
		/** The stable key the open state is remembered under (default `title`, which changes with the locale). */
		name?: string;
		/** No rule above: the first section of a body. */
		first?: boolean;
		/** Default true for a titled section. */
		collapsible?: boolean;
		/** Open until the viewer chooses otherwise. Default true: a secondary section passes `false`. */
		defaultOpen?: boolean;
		/** Shown beside the title while collapsed ("3 files", "Not set"). */
		summary?: string | Snippet;
		/** A mark on the title row — a state badge, never a control. */
		trailing?: Snippet;
		/** Controls that act on the section, at the end of the title row. */
		actions?: Snippet;
		/** `content` (default): its whole content; `fill`: shares the column's height left and scrolls inside itself. */
		size?: 'content' | 'fill';
		/** A `fill` section's floor (a CSS length; default its content or 16rem, whichever is less). */
		minHeight?: string;
		class?: string;
		children: Snippet;
	};
	/**
	 * A declared section of a generated record view or form (`RecordShell`/`Form` `sections`): its fields, in order. Its
	 * title and summary arrive translated; `summary` may read the row shown (the draft while editing).
	 */
	export type RecordSection = {
		/** The stable key the open state is remembered under. */
		name: string;
		title?: string;
		hint?: string;
		fields: readonly string[];
		defaultOpen?: boolean;
		summary?: string | ((row: { readonly [field: string]: unknown }) => string);
	};
	/** `names` grouped by `sections` in each section's order; names no section lists follow in one untitled group. */
	export function groupSections(
		sections: readonly RecordSection[],
		names: readonly string[]
	): { section?: RecordSection; names: string[] }[] {
		const known = new Set(names);
		const listed = new Set<string>();
		const groups = sections.map((section) => ({
			section,
			names: section.fields.filter((f) => known.has(f) && !listed.has(f) && listed.add(f))
		}));
		return [...groups, { names: names.filter((f) => !listed.has(f)) }].filter(
			(g) => g.names.length > 0
		);
	}
	const SECTION = Symbol.for('norbital.ui.section');
	/** A `Field` names itself to its section, so an error on it opens the section. */
	export const claimSectionField = (name: string) =>
		getContext<Set<string> | undefined>(SECTION)?.add(name);
</script>

<script lang="ts">
	import { Effect, Result } from 'effect';
	import { fork } from '../effect/index.js';
	import { contentMotion } from './content-motion.js';
	import Icon from '@iconify/svelte';
	import { flushSync, setContext } from 'svelte';
	import Tooltip from '../primitives/tooltip/tooltip.svelte';
	import { cn, useControls } from '../primitives/utils.js';
	import { useModelKey } from '../model/context.js';
	import { useForm } from './form-state.svelte.js';

	let {
		title,
		hint,
		name,
		first = false,
		collapsible = true,
		defaultOpen = true,
		summary,
		trailing,
		actions,
		size = 'content',
		minHeight,
		class: className,
		children
	}: SectionProps = $props();
	const id = $props.id();
	const form = useForm();
	const controls = useControls();
	const editing = $derived(
		form !== undefined && !controls.readonly && (form.mode === 'edit' || form.mode === 'create')
	);
	const fields = setContext(SECTION, new Set<string>());
	const canCollapse = $derived(title !== undefined && collapsible);
	// svelte-ignore state_referenced_locally -- the key is fixed for the section's life
	const key = `norbital.section:${useModelKey() ?? ''}:${name ?? title ?? ''}`;
	function stored(): boolean | null {
		return Result.getOrElse(
			Result.try({
				try: () => {
					const value = localStorage.getItem(key);
					return value === null ? null : value === '1';
				},
				catch: (cause) => ({ _tag: 'SectionStorageFailed' as const, cause })
			}),
			() => null
		);
	}

	// svelte-ignore state_referenced_locally -- defaultOpen is the starting state only
	let open = $state(stored() ?? defaultOpen);
	const invalid = $derived(
		form !== undefined &&
			[...form.errors.keys()].some((k) => fields.has(k) || fields.has(k.split('.')[0]!))
	);
	const shown = $derived(!canCollapse || open || invalid);
	let body = $state<HTMLElement | null>(null);
	// the natural height an open `fill` section shrinks no further than (with the default floor)
	let headingHeight = $state(0),
		contentHeight = $state(0);
	const fill = $derived(size === 'fill' && shown);
	const floor = $derived(
		minHeight ?? `min(${headingHeight + contentHeight + (title === undefined ? 0 : 16)}px, 16rem)`
	);
	/** The body still showing while it shrinks closed: `aria-expanded` follows the click, `hidden` the motion's end. */
	let closing = $state(false);
	const moving = (target: HTMLElement | null): target is HTMLElement =>
		target != null &&
		!target.hidden &&
		!document.hidden &&
		typeof target.animate === 'function' &&
		!window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	/** The body's height and opacity from one end to the other; a paused timeline ends on time regardless. */
	function slide(target: HTMLElement, opening: boolean, done: () => void) {
		// closing starts from the height shown, which a bounded column may hold below the content's
		const full = opening ? target.scrollHeight : target.offsetHeight;
		// the body's own resize motion (`contentMotion`) sits out the toggle: two height animations fight
		target.dataset['moving'] = '';
		const ends = [
			{ height: '0px', opacity: 0, overflow: 'clip' },
			{ height: `${full}px`, opacity: 1, overflow: 'clip' }
		];
		const motion = target.animate(opening ? ends : [...ends].reverse(), {
			duration: 200,
			easing: 'cubic-bezier(.2,.8,.2,1)'
		});
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			delete target.dataset['moving'];
			motion.cancel();
			done();
		};
		motion.onfinish = end;
		setTimeout(end, 260);
	}
	function toggle() {
		const opening = !shown;
		open = opening;
		if (opening) {
			closing = false;
			// shown and animated in the same frame: the body never paints at full height before growing
			flushSync();
			if (moving(body)) slide(body, true, () => {});
		} else if (moving(body)) {
			closing = true;
			slide(body, false, () => (closing = false));
		}
		fork(
			Effect.try({
				try: () => localStorage.setItem(key, opening ? '1' : '0'),
				catch: (cause) => ({ _tag: 'SectionStorageFailed' as const, cause })
			}),
			() => {}
		);
	}
</script>

<!-- in a bounded column: closed or `content`, its own height; open `fill`, the height left, down to `floor` -->
<section
	class={cn(
		'flex min-w-0 flex-col',
		fill ? 'min-h-0 flex-[1_1_0%]' : 'flex-none',
		!first && (editing ? 'border-t pt-4' : 'border-t pt-6'),
		className
	)}
	style:min-height={fill ? floor : undefined}
	data-section={name ?? title}
	data-open={shown}
>
	{#if title !== undefined}
		<div class="flex min-w-0 shrink-0 items-center gap-1.5" bind:clientHeight={headingHeight}>
			<h3 class="min-w-0 flex-1 text-sm font-bold">
				{#if canCollapse}
					<button
						type="button"
						class="max-sm:min-h-11 flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-expanded={shown}
						aria-controls={`${id}-body`}
						onclick={toggle}
					>
						<Icon
							icon="lucide:chevron-right"
							class={cn(
								'size-4 shrink-0 text-muted-foreground transition-transform',
								shown && 'rotate-90'
							)}
							aria-hidden="true"
						/>
						<span class="truncate">{title}</span>
						{#if !shown && summary !== undefined}
							<span class="text-meta truncate font-normal" data-section-summary
								>{#if typeof summary === 'string'}{summary}{:else}{@render summary()}{/if}</span
							>
						{/if}
					</button>
				{:else}{title}{/if}
			</h3>
			{#if hint}
				<Tooltip
					side="bottom"
					align="start"
					sideOffset={6}
					contentClass="max-w-96 border bg-popover text-popover-foreground"
					arrowClasses="text-popover"
				>
					{#snippet trigger({ props })}
						<button
							{...props}
							type="button"
							aria-label={hint}
							class="max-sm:min-h-11 max-sm:min-w-11 grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Icon icon="lucide:info" class="size-3" aria-hidden="true" />
						</button>
					{/snippet}
					{#snippet content()}<p class="px-2.5 py-2 text-left text-xs text-muted-foreground">
							{hint}
						</p>{/snippet}
				</Tooltip>
			{/if}
			{@render trailing?.()}
			{#if actions}<span class="flex shrink-0 items-center gap-2">{@render actions()}</span>{/if}
		</div>
	{/if}
	<!-- hidden, never unmounted: a collapsed field still belongs to the form's draft and its save -->
	<!-- the body scrolls inside the section's share; the inset keeps focus rings clear of its edge; under a chevron it
	     starts where the title does (the chevron's size-4 and gap-1.5) -->
	<div
		bind:this={body}
		id={`${id}-body`}
		hidden={!shown && !closing}
		class={cn(
			'-m-1 min-h-0 min-w-0 overflow-x-clip p-1',
			fill && 'overflow-y-auto',
			canCollapse && title !== undefined && 'pl-[calc(1.375rem+0.25rem)]'
		)}
		use:contentMotion
	>
		<div
			class={cn(
				'grid min-w-0 [overflow-wrap:anywhere]',
				editing ? 'gap-4' : 'gap-3',
				// the space under the heading moves with the body, so closing ends without a jump
				title !== undefined && (editing ? 'pt-4' : 'pt-3')
			)}
			bind:clientHeight={contentHeight}
		>
			{@render children()}
		</div>
	</div>
</section>
