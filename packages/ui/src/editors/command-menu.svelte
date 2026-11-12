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
	export type CommandMenuProps = {
		textarea: HTMLTextAreaElement | null;
		triggers: readonly CommandTrigger[];
	};
</script>

<script lang="ts">
	import { Effect, FiberHandle } from 'effect';
	import { attach, fork } from '../effect/index.js';
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import { Popover as P } from 'bits-ui';
	import { cn, ui_text } from '../primitives/utils.js';
	import { virtual_list } from '../primitives/virtual/virtual.svelte.js';
	import {
		applyItem,
		caretRect,
		findTrigger,
		type CommandItem,
		type Found
	} from './command-menu.js';

	let { textarea, triggers }: CommandMenuProps = $props();
	const t = ui_text();
	// raw: the trigger is compared by identity
	let found = $state.raw<Found | null>(null),
		items = $state.raw<readonly CommandItem[]>([]),
		active = $state(0),
		anchor = $state.raw<DOMRect | null>(null);
	let list = $state<HTMLElement | null>(null);
	let pending = $state(false);
	let request_id = 0;
	/** Esc closes the menu for this trigger until the writer types a new one. */
	let dismissed = -1;
	const open = $derived(found !== null && anchor !== null);
	// a group heading is its own entry, so a long list windows over measured entries (as `Combobox`)
	const entries = $derived(
		items.flatMap((item, i): ({ head: string; i: number } | { item: CommandItem; i: number })[] =>
			item.group !== undefined && item.group !== items[i - 1]?.group
				? [{ head: item.group, i }, { item, i }]
				: [{ item, i }]
		)
	);
	const entryOf = $derived(
		new Map(entries.flatMap((e, k) => ('head' in e ? [] : [[e.i, k] as const])))
	);
	const entryKey = (k: number) => {
		const e = entries[k];
		if (e === undefined) throw new RangeError('The command menu entry is outside its list.');
		return 'head' in e ? `head:${e.i}` : `item:${e.item.id}`;
	};
	const win = virtual_list({
		count: () => entries.length,
		key: entryKey,
		estimate: 32,
		threshold: 100
	});

	let request: FiberHandle.FiberHandle | undefined;
	const lifetime = attach(() =>
		Effect.gen(function* () {
			request = yield* FiberHandle.make();
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					request = undefined;
				})
			);
			yield* Effect.never;
		})
	);
	function refresh() {
		const ta = textarea;
		const f =
			ta === null || ta.selectionStart !== ta.selectionEnd
				? null
				: findTrigger(ta.value, ta.selectionStart, triggers);
		if (f === null || f.start === dismissed) {
			found = null;
			if (f === null) dismissed = -1;
			return;
		}
		const same = found?.trigger === f.trigger && found.query === f.query && found.start === f.start;
		found = f;
		if (ta === null) return;
		anchor = caretRect(ta, f.start);
		if (same) return;
		const current = ++request_id;
		pending = true;
		items = [];
		const work = f.trigger.items(f.query).pipe(
			Effect.tap((next) =>
				Effect.sync(() => {
					if (current === request_id && found?.trigger === f.trigger && found.query === f.query) {
						items = [...next];
						active = Math.max(
							-1,
							next.findIndex((item) => !item.disabled && !item.back)
						);
					}
				})
			),
			Effect.catch((error) =>
				Effect.logWarning(error).pipe(
					Effect.tap(() =>
						Effect.sync(() => {
							if (current === request_id)
								items = [{ id: 'error', label: error.message, disabled: true }];
						})
					)
				)
			),
			Effect.ensuring(
				Effect.sync(() => {
					if (current === request_id) pending = false;
				})
			)
		);
		if (request !== undefined) fork(FiberHandle.run(request, work));
	}
	function pick(item: CommandItem) {
		if (item.disabled) return;
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
	function explore(item: CommandItem) {
		const drill = item.drill;
		if (drill !== undefined) pick({ ...item, insert: drill.insert, keep: true });
	}
	function keydown(e: KeyboardEvent) {
		if (!open || e.isComposing) return;
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			for (let step = 0; step < items.length; step++) {
				active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
				if (!items[active]?.disabled) break;
			}
		} else if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowRight') {
			const item = items[active];
			if (e.key === 'ArrowRight' && item?.drill === undefined) return;
			if (item !== undefined) {
				if (e.key !== 'Enter' && item.drill !== undefined) explore(item);
				else pick(item);
			}
		} else if (
			e.key === 'Escape' ||
			((e.key === 'Backspace' || e.key === 'ArrowLeft') &&
				/^\S+\s$/.test(found?.query ?? '') &&
				items.some((item) => item.back))
		) {
			const back = items.find((item) => item.back);
			if (back) pick(back);
			else {
				dismissed = found?.start ?? -1;
				found = null;
			}
		} else return;
		// the owner's own Enter (send, submit) must not also fire
		e.preventDefault();
		e.stopPropagation();
		void tick().then(() =>
			win.on
				? win.reveal(entryOf.get(active) ?? 0)
				: list?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
		);
	}
	$effect(() => {
		const ta = textarea;
		if (ta === null) return;
		const events = ['input', 'click', 'keyup'] as const;
		const later = () => queueMicrotask(refresh);
		ta.addEventListener('keydown', keydown);
		for (const name of events) ta.addEventListener(name, later);
		return () => {
			ta.removeEventListener('keydown', keydown);
			for (const name of events) ta.removeEventListener(name, later);
		};
	});
</script>

<div class="contents" {@attach lifetime}>
	{#if open}
		<P.Root
			open
			onOpenChange={(o) => {
				if (!o && found !== null) {
					dismissed = found.start;
					found = null;
				}
			}}
		>
			<P.Portal>
				<P.Content
					customAnchor={{ getBoundingClientRect: () => anchor ?? new DOMRect() }}
					side="bottom"
					align="start"
					sideOffset={4}
					trapFocus={false}
					onOpenAutoFocus={(e) => e.preventDefault()}
					onCloseAutoFocus={(e) => e.preventDefault()}
					onEscapeKeydown={(e) => {
						const back = items.find((item) => item.back);
						if (back) {
							e.preventDefault();
							e.stopPropagation();
							pick(back);
						}
					}}
					onInteractOutside={(e) => {
						if (e.target === textarea) e.preventDefault();
					}}
					class="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-1 text-popover-foreground shadow-deep"
					data-command-menu={found?.trigger.char}
				>
					<ul bind:this={list} role="listbox" class="max-h-72 overflow-auto">
						{#if pending}<li role="status" class="px-2 py-2 text-sm text-muted-foreground">
								{t('searching')}
							</li>{:else if items.length === 0}<li
								role="status"
								class="px-2 py-2 text-sm text-muted-foreground"
							>
								{t('noResults')}
							</li>{/if}
						{#if win.on}<li
								role="presentation"
								style="height:{win.before}px"
								{@attach win.anchor}
							></li>{/if}
						{#each win.slice(entries) as e, j (entryKey(win.start + j))}
							{@const i = e.i}
							{#if 'head' in e}
								<li
									role="presentation"
									class="px-2 pt-2 pb-1 text-overline text-muted-foreground"
									{@attach win.measure(entryKey(win.start + j))}
								>
									{e.head}
								</li>
							{:else}
								{@const item = e.item}
								<li
									role="option"
									aria-selected={i === active && !item.disabled}
									aria-disabled={item.disabled || undefined}
									data-index={i}
									data-item={item.id}
									class={cn('relative', item.depth && 'ml-3 border-l border-border pl-2')}
									{@attach win.measure(entryKey(win.start + j))}
								>
									<button
										type="button"
										disabled={item.disabled}
										aria-expanded={item.back ? true : undefined}
										tabindex="-1"
										class={cn(
											'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
											item.drill && 'pr-9',
											i === active && !item.disabled && 'bg-accent text-accent-foreground'
										)}
										onmousedown={(e) => e.preventDefault()}
										onmousemove={() => {
											if (!item.disabled) active = i;
										}}
										onclick={() => pick(item)}
									>
										{#if item.icon}<Icon
												icon={item.icon}
												class="size-4 shrink-0 text-muted-foreground"
											/>{/if}
										<span class="min-w-0 flex-1">
											<span class="block truncate">{item.label}</span>
											{#if item.description}<span class="block text-xs text-muted-foreground"
													>{item.description}</span
												>{/if}
										</span>
										{#if item.back}<Icon
												icon="lucide:chevron-down"
												class="size-3.5 shrink-0 text-muted-foreground"
											/>{:else if item.keep && !item.drill}<Icon
												icon="lucide:chevron-right"
												class="size-3.5 shrink-0 text-muted-foreground"
											/>{/if}
									</button>
									{#if item.drill}<button
											type="button"
											tabindex="-1"
											aria-label={item.drill.label}
											title={item.drill.label}
											class="absolute inset-y-0 right-0 grid w-8 place-items-center rounded-sm text-muted-foreground hover:bg-accent"
											onmousedown={(e) => e.preventDefault()}
											onclick={() => explore(item)}
											><Icon icon="lucide:chevron-right" class="size-3.5" /></button
										>{/if}
								</li>
							{/if}
						{/each}
						{#if win.after > 0}<li role="presentation" style="height:{win.after}px"></li>{/if}
					</ul>
					{#if items.some((item) => item.drill || item.back)}<div
							class="mt-1 flex gap-3 border-t px-2 pt-2 pb-1 text-xs text-muted-foreground"
						>
							<span><kbd>Enter</kbd> {t('selectItem')}</span>{#if items[active]?.drill}<span
									><kbd>Tab</kbd> {t('explore')}</span
								>{/if}{#if items.some((item) => item.back)}<span class="ml-auto"
									><kbd>Esc</kbd> {t('back')}</span
								>{/if}
						</div>{/if}
				</P.Content>
			</P.Portal>
		</P.Root>
	{/if}
</div>
