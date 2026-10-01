<!--
@component
One titled section of a form or record body: a heading row (title, an optional ⓘ hint, a mark, actions) over its content.
A titled section collapses from its heading; the body is hidden, never unmounted, so every field in it still saves.
Closed, the heading shows `summary` so nothing important is out of sight. The viewer's open state is remembered per
collection and section; a section holding a field with an error opens itself.
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
		class?: string;
		children: Snippet;
	};
	const SECTION = Symbol.for('norbital.ui.section');
	/** A `Field` names itself to its section, so an error on it opens the section. */
	export const claimSectionField = (name: string) => getContext<Set<string> | undefined>(SECTION)?.add(name);
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { setContext } from 'svelte';
	import Tooltip from '../primitives/tooltip/tooltip.svelte';
	import { cn } from '../primitives/utils.js';
	import { useCollectionKey } from '../views/bolt.js';
	import { useForm } from './form-state.svelte.js';

	let { title, hint, name, first = false, collapsible = true, defaultOpen = true, summary, trailing, actions, class: className, children }: SectionProps = $props();
	const id = $props.id();
	const form = useForm();
	const fields = setContext(SECTION, new Set<string>());
	const canCollapse = $derived(title !== undefined && collapsible);
	// svelte-ignore state_referenced_locally -- the key is fixed for the section's life
	const key = `norbital.section:${useCollectionKey() ?? ''}:${name ?? title ?? ''}`;
	function stored(): boolean | null {
		try {
			const v = localStorage.getItem(key);
			return v === null ? null : v === '1';
		} catch {
			return null;
		}
	}
	// svelte-ignore state_referenced_locally -- defaultOpen is the starting state only
	let open = $state(stored() ?? defaultOpen);
	const invalid = $derived(form !== undefined && [...form.errors.keys()].some((k) => fields.has(k) || fields.has(k.split('.')[0]!)));
	const shown = $derived(!canCollapse || open || invalid);
	function toggle() {
		open = !shown;
		try {
			localStorage.setItem(key, open ? '1' : '0');
		} catch {
			// storage blocked: the choice lasts this mount
		}
	}
</script>

<section class={cn('grid min-w-0 gap-3', !first && 'border-t pt-6', className)} data-section={name ?? title} data-open={shown}>
	{#if title !== undefined}
		<div class="flex min-w-0 items-center gap-1.5">
			<h3 class="min-w-0 flex-1 text-base font-semibold">
				{#if canCollapse}
					<button type="button" class="flex w-full min-w-0 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={shown} aria-controls={`${id}-body`} onclick={toggle}>
						<Icon icon="lucide:chevron-right" class={cn('size-4 shrink-0 text-muted-foreground transition-transform', shown && 'rotate-90')} aria-hidden="true" />
						<span class="truncate">{title}</span>
						{#if !shown && summary !== undefined}
							<span class="text-meta truncate font-normal" data-section-summary>{#if typeof summary === 'string'}{summary}{:else}{@render summary()}{/if}</span>
						{/if}
					</button>
				{:else}{title}{/if}
			</h3>
			{#if hint}
				<Tooltip side="bottom" align="start" sideOffset={6} contentClass="max-w-96 border bg-popover text-popover-foreground" arrowClasses="text-popover">
					{#snippet trigger({ props })}
						<button {...props} type="button" aria-label={hint} class="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
							<Icon icon="lucide:info" class="size-3" aria-hidden="true" />
						</button>
					{/snippet}
					{#snippet content()}<p class="px-2.5 py-2 text-left text-xs text-muted-foreground">{hint}</p>{/snippet}
				</Tooltip>
			{/if}
			{@render trailing?.()}
			{#if actions}<span class="flex shrink-0 items-center gap-2">{@render actions()}</span>{/if}
		</div>
	{/if}
	<!-- hidden, never unmounted: a collapsed field still belongs to the form's draft and its save -->
	<div id={`${id}-body`} hidden={!shown}>
		<div class="grid min-w-0 gap-3">{@render children()}</div>
	</div>
</section>
