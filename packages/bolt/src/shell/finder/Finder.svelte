<!-- One input: app names or an explicit /scope query, shared with Norbius. -->
<script lang="ts">
	import { Effect } from 'effect';
	import { attach } from '@norbital-ai/ui/effect';
	import { watch } from 'runed';
	import { tick } from 'svelte';
	import { Dialog, Icon, Input, type ModelExposure } from '@norbital-ai/ui';
	import type { NavNode } from '../nav.ts';
	import type { ManifestItem } from './manifest.ts';
	import {
		manifestMatches,
		recordFinder,
		searchScopes,
		scopeQuery,
		scopedPages,
		canDrill,
		scopeKind,
		scopeIcon,
		type FinderHit,
		type FinderRead,
		type SearchScope
	} from './model.ts';

	let {
		open = $bindable(false),
		nav,
		catalog,
		read,
		t,
		on_navigate,
		on_open_record,
		on_ask,
		entries = [],
		initial_scope = null,
		on_close
	}: {
		open?: boolean;
		nav: readonly NavNode[];
		catalog: { readonly [model: string]: ModelExposure };
		read: FinderRead;
		t: (key: string) => string;
		on_navigate: (href: string) => void;
		on_open_record: (model: string, id: string) => void;
		on_ask: ((prompt: string) => void) | null;
		entries?: readonly ManifestItem[];
		initial_scope?: string | null;
		on_close?: () => void;
	} = $props();
	let query = $state('');
	let found = $state<FinderHit[]>([]);
	let searching = $state(false);
	let error = $state('');
	let active = $state(0);
	let searchInput = $state<HTMLInputElement | null>(null);
	let picked = $state<SearchScope | undefined>();
	let previousQuery = $state('');
	const scopes = $derived(searchScopes(nav, catalog, t, entries));
	const parsed = $derived(scopeQuery(scopes, query));
	const selected = $derived(parsed.scope ?? picked);
	const term = $derived(parsed.scope ? parsed.query : query);
	const model = $derived(selected?.kind === 'model' ? selected.model : null);
	const description = $derived(
		selected?.kind === 'app'
			? t('Only pages in this app.')
			: selected?.description || t('Search apps, models, automations and more.')
	);
	type Row =
		| FinderHit
		| { kind: 'scope'; key: string; scope: SearchScope }
		| { kind: 'ask'; key: 'ask'; label: string };
	const rows = $derived<Row[]>(
		selected?.kind === 'model'
			? found
			: selected?.kind === 'app'
				? scopedPages(selected, term)
				: [
						...manifestMatches(nav, scopes, parsed.query, t),
						...(on_ask !== null && !parsed.explicit && query.trim() !== ''
							? [{ kind: 'ask' as const, key: 'ask' as const, label: query.trim() }]
							: [])
					]
	);
	const disabled = (row: Row) =>
		row.kind === 'scope' && row.scope.kind === 'model' && !row.scope.searchable;
	const activeRow = $derived(rows[active]);
	watch(
		() => parsed.scope,
		(scope) => {
			if (scope === undefined) return;
			const scopedQuery = parsed.query;
			picked = scope;
			previousQuery = scope.label;
			query = scopedQuery;
			void tick().then(() =>
				searchInput?.setSelectionRange(scopedQuery.length, scopedQuery.length)
			);
		}
	);
	watch(
		() => [initial_scope, open] as const,
		([name, visible]) => {
			if (visible && name !== null) {
				picked = scopes.find((scope) => scope.command === name);
				query = '';
			}
		}
	);
	watch(
		() => [query, open, picked] as const,
		() => {
			active = 0;
			found = [];
			error = '';
		}
	);
	watch(
		() => rows.map((row) => row.key).join('\0'),
		() => {
			active = Math.max(
				0,
				rows.findIndex((row) => !disabled(row))
			);
		}
	);
	const search = (visible: boolean, model: string | null, term: string) =>
		attach(() =>
			Effect.gen(function* () {
				searching = false;
				if (
					!visible ||
					model === null ||
					term.trim() === '' ||
					selected?.kind !== 'model' ||
					!selected.searchable
				)
					return;
				searching = true;
				yield* Effect.sleep('200 millis');
				const finder = yield* recordFinder(catalog, read, t);
				const hits = yield* finder.search(model, term);
				if (hits !== null) found = [...hits];
			}).pipe(
				Effect.catch((cause) =>
					Effect.sync(() => {
						error = cause.message;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						searching = false;
					})
				)
			)
		);
	async function drill(scope: SearchScope): Promise<void> {
		previousQuery = picked ? previousQuery : query;
		picked = scope;
		query = '';
		await tick();
		searchInput?.focus();
	}
	async function back(): Promise<void> {
		picked = undefined;
		query = parsed.explicit ? '' : previousQuery;
		await tick();
		searchInput?.focus();
	}
	async function choose(row: Row | undefined): Promise<void> {
		if (row === undefined || disabled(row)) return;
		if (
			row.kind === 'scope' &&
			(row.scope.kind === 'model' || (row.scope.kind === 'app' && row.scope.pages.length > 1))
		) {
			return drill(row.scope);
		}
		open = false;
		if (row.kind === 'ask') on_ask?.(row.label);
		else if (row.kind === 'page') on_navigate(row.href);
		else if (row.kind === 'record') on_open_record(row.model, row.id);
		else if (row.scope.kind !== 'model') on_navigate(row.scope.href);
		query = '';
		picked = undefined;
		on_close?.();
	}
	function keydown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		const current = rows[active];
		const atStart = searchInput?.selectionStart === 0 && searchInput.selectionEnd === 0;
		if (
			(event.key === 'ArrowLeft' && atStart && selected) ||
			(event.key === 'Backspace' && query === '' && selected)
		) {
			event.preventDefault();
			void back();
		} else if (
			(event.key === 'Tab' || event.key === 'ArrowRight') &&
			current?.kind === 'scope' &&
			canDrill(current.scope)
		) {
			event.preventDefault();
			void drill(current.scope);
		} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			for (let step = 0; step < rows.length; step++) {
				active = (active + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
				const next = rows[active];
				if (next !== undefined && !disabled(next)) break;
			}
			document
				.getElementById(`shell-finder-result-${active}`)
				?.scrollIntoView({ block: 'nearest' });
		} else if (event.key === 'Enter') {
			event.preventDefault();
			void choose(rows[active]);
		}
	}
</script>

{#snippet resultRows()}
	{#each rows as row, i (row.key)}
		<li
			id="shell-finder-result-{i}"
			role="option"
			aria-selected={i === active}
			aria-disabled={disabled(row)}
		>
			<button
				type="button"
				disabled={disabled(row)}
				class={[
					'flex w-full items-start gap-2 rounded-md px-2 py-2 text-left disabled:opacity-60',
					i === active && 'bg-accent text-accent-foreground'
				]}
				onmouseenter={() => {
					if (!disabled(row)) active = i;
				}}
				onclick={() => choose(row)}
			>
				<Icon
					name={row.kind === 'ask'
						? 'lucide:sparkles'
						: row.kind === 'scope'
							? scopeIcon(row.scope)
							: row.kind === 'record'
								? 'lucide:file-text'
								: 'lucide:layout-grid'}
					class="mt-0.5 size-4 shrink-0 text-muted-foreground"
				/>
				{#if row.kind === 'scope'}
					<span class="flex min-w-0 flex-1 flex-col gap-0.5">
						<span>{row.scope.label}</span>{#if row.scope.description}<span
								class="text-meta whitespace-normal">{row.scope.description}</span
							>{/if}
					</span>
					<span class="text-meta shrink-0">{t(scopeKind(row.scope))}</span>
					{#if canDrill(row.scope)}<Icon
							name="lucide:chevron-right"
							class="mt-0.5 size-4 shrink-0 text-muted-foreground"
						/>{/if}
				{:else if row.kind === 'ask'}
					<span class="shrink-0 text-muted-foreground">{t('Ask Norbius')}</span><span
						class="min-w-0 truncate">{row.label}</span
					>
				{:else}
					<span class="min-w-0 truncate">{row.label}</span>
					{#if row.context}<span class="ml-auto max-w-[40%] truncate text-meta">{row.context}</span
						>{/if}
				{/if}
			</button>
		</li>
	{/each}
	{#if rows.length === 0}<li
			class="flex min-h-24 items-center justify-center px-4 py-6 text-center text-xs text-muted-foreground"
		>
			{#if error !== ''}<p role="alert" class="text-destructive">
					{error}
				</p>{:else if searching}<p role="status">
					{t('Searching…')}
				</p>{:else if selected?.kind === 'model' && selected.searchable && term.trim() === ''}<p
					role="status"
				>
					{t('Search for a record to open.')}
				</p>{:else if selected?.kind === 'model' && !selected.searchable}<p role="status">
					{t('Record search is unavailable.')}
				</p>{:else}<p role="status">
					{parsed.explicit && selected === undefined
						? t('Scope not found. Search by name or go back to all results.')
						: t('Nothing found.')}
				</p>{/if}
		</li>{/if}
{/snippet}

<span hidden {@attach search(open, model, term)}></span>
<Dialog.Root
	bind:open
	on_open_change={(visible) => {
		if (!visible) on_close?.();
	}}
>
	<Dialog.Content
		class="top-[15%] max-w-2xl translate-y-0 [&>button]:top-5 [&>button]:grid [&>button]:size-8 [&>button]:place-items-center max-md:[&>button]:top-3.5 max-md:[&>button]:size-11"
		data-finder
		on_escape_keydown={(event) => {
			if (selected) {
				event.preventDefault();
				void back();
			}
		}}
	>
		<Dialog.Title class="pr-8 text-subhead">{t('Find')}</Dialog.Title>
		<div
			class="flex min-w-0 items-center gap-2 rounded-sm border border-input bg-background px-2 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 focus-within:ring-inset dark:bg-input/30"
			data-finder-search
		>
			{#if selected}<span
					class="inline-flex max-w-[55%] shrink-0 items-center gap-1.5 rounded-sm bg-muted px-2 py-1 text-xs"
					data-search-scope
					><Icon name={scopeIcon(selected)} class="size-3.5 shrink-0 text-muted-foreground" /><span
						class="truncate"
						title={selected.label}>{selected.label}</span
					><button
						type="button"
						aria-label={t('Back to all results')}
						class="grid size-4 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
						onclick={() => back()}><Icon name="lucide:x" class="size-3" /></button
					></span
				>{/if}
			<Input
				class="min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
				bind:ref={searchInput}
				autofocus
				placeholder={selected
					? t(selected.kind === 'app' ? 'Search pages…' : 'Search records…')
					: t('Search anything…')}
				aria-label={t('Find')}
				bind:value={query}
				onkeydown={keydown}
				role="combobox"
				aria-expanded={rows.length > 0}
				aria-controls="shell-finder-results"
				aria-describedby="shell-finder-scope-description"
				aria-activedescendant={rows[active] === undefined
					? undefined
					: `shell-finder-result-${active}`}
			/>
		</div>
		<Dialog.Description id="shell-finder-scope-description" class="text-xs text-muted-foreground">
			{description}
		</Dialog.Description>

		<ul
			id="shell-finder-results"
			role="listbox"
			aria-label={t('Results')}
			class="h-80 max-h-[45dvh] overflow-y-auto text-sm"
		>
			{#if selected}<li role="presentation" data-finder-branch>
					<button
						type="button"
						class="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left"
						aria-expanded="true"
						aria-label={t('Collapse {scope}').replace('{scope}', selected.label)}
						onclick={() => back()}
						><Icon
							name={scopeIcon(selected)}
							class="mt-0.5 size-4 shrink-0 text-muted-foreground"
						/><span class="flex min-w-0 flex-1 flex-col gap-0.5"
							><span>{selected.label}</span
							>{#if selected.kind === 'app' && selected.description}<span class="text-meta"
									>{selected.description}</span
								>{/if}</span
						><span class="text-meta">{t(scopeKind(selected))}</span><Icon
							name="lucide:chevron-down"
							class="mt-0.5 size-4 text-muted-foreground"
						/></button
					>
					<ul role="group" aria-label={selected.label} class="ml-4 border-l border-border pl-2">
						{@render resultRows()}
					</ul>
				</li>{:else}{@render resultRows()}{/if}
		</ul>
		<div
			class="flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground pointer-coarse:hidden"
		>
			<span><kbd>↑ ↓</kbd> {t('Navigate')}</span><span
				><kbd>Enter</kbd>
				{t(
					activeRow?.kind === 'scope' &&
						(activeRow.scope.kind === 'model' ||
							(activeRow.scope.kind === 'app' && activeRow.scope.pages.length > 1))
						? 'Explore'
						: 'Open'
				)}</span
			>{#if activeRow?.kind === 'scope' && canDrill(activeRow.scope)}<span
					><kbd>Tab</kbd> {t('Explore')}</span
				>{/if}{#if selected}<span class="ml-auto"><kbd>Esc</kbd> {t('Back')}</span>{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
