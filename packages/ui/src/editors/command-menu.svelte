<!--
@component
A keyboard-driven menu at a textarea's caret, opened by trigger characters (`/` commands, `@` mentions); a pick rewrites the text.
-->
<script lang="ts" module>
	import type { CommandTrigger } from './command-menu.js';

	/**
	 * A filtered, keyboard-driven list anchored at a textarea's caret, opened by trigger characters (`/` commands, `@`
	 * mentions). It listens on the textarea it is given, so any textarea gets it: ↑/↓ move, Enter or Tab picks, Esc
	 * closes; the pick rewrites the text and dispatches `input`, so `bind:value` follows.
	 */
	export type CommandMenuProps = { textarea: HTMLTextAreaElement | null; triggers: readonly CommandTrigger[] };
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import { Popover as P } from 'bits-ui';
	import { cn } from '../primitives/utils.js';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import { applyItem, caretRect, findTrigger, type CommandItem, type Found } from './command-menu.js';

	let { textarea, triggers }: CommandMenuProps = $props();
	// raw: the trigger is compared by identity
	let found = $state.raw<Found | null>(null), items = $state.raw<readonly CommandItem[]>([]), active = $state(0), anchor = $state.raw<DOMRect | null>(null);
	let list = $state<HTMLElement | null>(null);
	/** Esc closes the menu for this trigger until the writer types a new one. */
	let dismissed = -1;
	const open = $derived(found !== null && items.length > 0 && anchor !== null);
	// a group heading is its own entry, so a long list windows over measured entries (as `Combobox`)
	const entries = $derived(items.flatMap((item, i): ({ head: string; i: number } | { i: number })[] =>
		item.group !== undefined && item.group !== items[i - 1]?.group ? [{ head: item.group, i }, { i }] : [{ i }]));
	const entryOf = $derived(new Map(entries.flatMap((e, k) => 'head' in e ? [] : [[e.i, k] as const])));
	const entryKey = (k: number) => { const e = entries[k]!; return 'head' in e ? `head:${e.i}` : `item:${items[e.i]?.id}`; };
	const win = virtualList({ count: () => entries.length, key: entryKey, estimate: 32, threshold: 100 });

	function refresh() {
		const ta = textarea;
		const f = ta === null || ta.selectionStart !== ta.selectionEnd ? null : findTrigger(ta.value, ta.selectionStart, triggers);
		if (f === null || f.start === dismissed) { found = null; if (f === null) dismissed = -1; return; }
		const same = found?.trigger === f.trigger && found.query === f.query && found.start === f.start;
		found = f;
		anchor = caretRect(ta!, f.start);
		if (same) return;
		void Promise.resolve(f.trigger.items(f.query)).then((next) => {
			if (found?.trigger === f.trigger && found.query === f.query) { items = next; active = 0; }
		});
	}
	function pick(item: CommandItem) {
		const ta = textarea;
		if (ta === null || found === null) return;
		const r = applyItem(ta.value, found, ta.selectionStart, item);
		ta.value = r.text;
		ta.setSelectionRange(r.caret, r.caret);
		ta.dispatchEvent(new Event('input', { bubbles: true }));
		ta.focus();
		item.run?.();
		found = null;
		refresh();
	}
	function keydown(e: KeyboardEvent) {
		if (!open || e.isComposing) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
		else if (e.key === 'Enter' || e.key === 'Tab') pick(items[active]!);
		else if (e.key === 'Escape') { dismissed = found!.start; found = null; }
		else return;
		// the owner's own Enter (send, submit) must not also fire
		e.preventDefault();
		e.stopPropagation();
		void tick().then(() => win.on ? win.reveal(entryOf.get(active) ?? 0) : list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }));
	}
	$effect(() => {
		const ta = textarea;
		if (ta === null) return;
		const events = ['input', 'click', 'keyup'] as const;
		const later = () => queueMicrotask(refresh);
		ta.addEventListener('keydown', keydown);
		for (const name of events) ta.addEventListener(name, later);
		return () => { ta.removeEventListener('keydown', keydown); for (const name of events) ta.removeEventListener(name, later); };
	});
</script>

{#if open}
	<P.Root open onOpenChange={(o) => { if (!o && found !== null) { dismissed = found.start; found = null; } }}>
		<P.Portal>
			<P.Content
				customAnchor={{ getBoundingClientRect: () => anchor! }}
				side="bottom"
				align="start"
				sideOffset={4}
				trapFocus={false}
				onOpenAutoFocus={(e) => e.preventDefault()}
				onCloseAutoFocus={(e) => e.preventDefault()}
				onInteractOutside={(e) => { if (e.target === textarea) e.preventDefault(); }}
				class="z-50 w-72 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
				data-command-menu={found?.trigger.char}
			>
				<ul bind:this={list} role="listbox" class="max-h-72 overflow-auto">
					{#if win.on}<li role="presentation" style="height:{win.before}px" {@attach win.anchor}></li>{/if}
					{#each win.slice(entries) as e, j (entryKey(win.start + j))}
						{@const i = e.i}
						{@const item = items[i]!}
						{#if 'head' in e}
							<li role="presentation" class="px-2 pt-2 pb-1 text-overline text-muted-foreground" {@attach win.measure(entryKey(win.start + j))}>{e.head}</li>
						{:else}
						<li role="option" aria-selected={i === active} data-index={i} data-item={item.id} {@attach win.measure(entryKey(win.start + j))}>
							<button type="button" tabindex="-1" class={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm', i === active && 'bg-accent text-accent-foreground')}
								onmousedown={(e) => e.preventDefault()} onmousemove={() => (active = i)} onclick={() => pick(item)}>
								{#if item.icon}<Icon icon={item.icon} class="size-4 shrink-0 text-muted-foreground" />{/if}
								<span class="min-w-0 flex-1">
									<span class="block truncate">{item.label}</span>
									{#if item.description}<span class="block truncate text-xs text-muted-foreground">{item.description}</span>{/if}
								</span>
								{#if item.keep}<Icon icon="lucide:chevron-right" class="size-3.5 shrink-0 text-muted-foreground" />{/if}
							</button>
						</li>
						{/if}
					{/each}
					{#if win.after > 0}<li role="presentation" style="height:{win.after}px"></li>{/if}
				</ul>
			</P.Content>
		</P.Portal>
	</P.Root>
{/if}
