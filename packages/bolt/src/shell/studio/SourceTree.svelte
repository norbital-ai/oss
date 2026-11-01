<!--
	Studio's source navigator : the workspace as a tree — folders fold (closed unless they hold the open file), each row an
	icon, the name and a change mark (A added, M modified, D deleted; a folder holding a change shows a dot) or the file's
	size. Names wear the change's colour (green added, yellow modified, red deleted) over saves and unsaved drafts. A
	filter lists matching paths; the rail above owns it and the source/changes switch.
-->
<script lang="ts">
	import { Icon } from '@norbital-ai/ui';
	import { Scroll, Stack } from '@norbital-ai/ui/layout';
	import { dirtyFolders, sizeText, type StudioState } from './model.ts';

	let {
		files,
		base,
		changes,
		drafts,
		selected,
		query = $bindable(''),
		folds = $bindable({}),
		onselect,
		oncreate,
		t
	}: {
		files: readonly string[];
		base: StudioState['files'];
		changes: StudioState['changes'];
		drafts: { readonly [path: string]: string | null };
		selected: string;
		query?: string;
		folds?: { [dir: string]: boolean };
		onselect: (path: string) => void;
		/** Create a file in `dir` (`''` is the workspace root). */
		oncreate: (dir: string) => void;
		t: (key: string) => string;
	} = $props();

	type Node = { name: string; path: string; dir: boolean };
	type Status = 'added' | 'modified' | 'deleted';
	const TONE: { readonly [s in Status]: string } = {
		added: 'text-success',
		modified: 'text-warning-foreground dark:text-warning',
		deleted: 'text-destructive'
	};
	const MARK: { readonly [s in Status]: string } = { added: 'A', modified: 'M', deleted: 'D' };
	const needle = $derived(query.trim().toLowerCase());
	const matches = $derived(
		needle === '' ? [] : files.filter((p) => p.toLowerCase().includes(needle))
	);
	const committed = $derived(new Map(changes.map((change) => [change.path, change.change])));

	/** The entries directly under `dir` (`''`: the root): folders first, then files, each by name. */
	function children(dir: string): Node[] {
		const prefix = dir === '' ? '' : `${dir}/`;
		const seen = new Map<string, Node>();
		for (const p of files) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length),
				slash = rest.indexOf('/');
			const name = slash === -1 ? rest : rest.slice(0, slash);
			if (!seen.has(name)) seen.set(name, { name, path: prefix + name, dir: slash !== -1 });
		}
		return [...seen.values()].sort((a, b) =>
			a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1
		);
	}
	const isOpen = (dir: string) => folds[dir] ?? selected.startsWith(`${dir}/`);
	/** A draft wins over the committed change: it is newer than the tree on disk. */
	const statusOf = (path: string): Status | null => {
		if (path in drafts)
			return drafts[path] === null ? 'deleted' : path in base ? 'modified' : 'added';
		return committed.get(path) ?? null;
	};
	const dirtyDirs = $derived(
		dirtyFolders([...new Set([...Object.keys(drafts), ...changes.map((change) => change.path)])])
	);
	const dirty = (dir: string) => dirtyDirs.has(`${dir}/`);
	// a changed file shows its mark instead, so a size is always the saved file's
	const size = (path: string) => sizeText(base[path]?.bytes ?? 0);
	const FILE_ICONS: readonly [RegExp, string][] = [
		[/^package\.json$/, 'npm'],
		[/^tsconfig.*\.json$/, 'tsconfig'],
		[/\.svelte$/, 'svelte'],
		[/\.[cm]?ts$/, 'typescript'],
		[/\.[cm]?js$/, 'js'],
		[/\.json$/, 'json'],
		[/\.mdx?$/, 'markdown'],
		[/\.css$/, 'css'],
		[/\.sql$/, 'sql'],
		[/\.ya?ml$/, 'yaml'],
		[/\.svg$/, 'svg']
	];
	function icon(node: Node): string {
		if (node.dir)
			return isOpen(node.path)
				? 'vscode-icons:default-folder-opened'
				: 'vscode-icons:default-folder';
		const kind = FILE_ICONS.find(([pattern]) => pattern.test(node.name.toLowerCase()))?.[1];
		return kind === undefined ? 'vscode-icons:default-file' : `vscode-icons:file-type-${kind}`;
	}
</script>

{#snippet row(node: Node, depth: number, label: string)}
	{@const state = node.dir ? null : statusOf(node.path)}
	{@const m = node.dir
		? dirty(node.path)
			? { label: '·', tone: '' }
			: null
		: state === null
			? null
			: { label: MARK[state], tone: TONE[state] }}
	{@const current = !node.dir && node.path === selected}
	<div
		class="group relative min-w-0"
		role="treeitem"
		aria-selected={current}
		aria-expanded={node.dir ? isOpen(node.path) : undefined}
		data-status={state ?? undefined}
	>
		{#each { length: depth } as _, i (i)}
			<span
				class="pointer-events-none absolute inset-y-0 w-px bg-border/50"
				style="left: {0.625 + i * 0.625 + 0.45}rem"
				aria-hidden="true"
			></span>
		{/each}
		<button
			type="button"
			title={node.path}
			aria-current={current}
			class="relative flex w-full min-w-0 items-center gap-1 rounded-md py-1.5 text-left text-xs leading-snug transition-colors hover:bg-muted/50 {node.dir
				? 'pr-8'
				: 'pr-1.5'} {current ? 'bg-accent text-accent-foreground' : ''}"
			style="padding-left: {0.625 + depth * 0.625}rem"
			onclick={() => (node.dir ? (folds[node.path] = !isOpen(node.path)) : onselect(node.path))}
		>
			<span class="grid size-4 shrink-0 place-items-center">
				{#if node.dir}<Icon
						name="lucide:chevron-right"
						class="size-3.5 text-muted-foreground transition-transform duration-200 {isOpen(
							node.path
						)
							? 'rotate-90'
							: ''}"
					/>{/if}
			</span>
			<Icon name={icon(node)} class="size-3.5 shrink-0" />
			<span
				class="min-w-0 flex-1 truncate {state === 'deleted' ? 'line-through' : ''} {state === null
					? 'text-foreground'
					: TONE[state]}">{label}</span
			>
			{#if m !== null}
				<span
					class="shrink-0 text-tiny font-semibold tabular-nums {m.tone || 'text-muted-foreground'}"
					>{m.label}</span
				>
			{:else if !node.dir && state !== 'deleted'}
				<span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
					>{size(node.path)}</span
				>
			{/if}
		</button>
		{#if node.dir}
			<button
				type="button"
				class="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground opacity-100 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:opacity-0 md:group-hover:opacity-100"
				aria-label={`${t('New file in')} ${node.path}`}
				title={t('New file')}
				onclick={() => oncreate(node.path)}
			>
				<Icon name="lucide:plus" class="size-3.5" />
			</button>
		{/if}
	</div>
	{#if node.dir && isOpen(node.path)}
		{#each children(node.path) as child (child.path)}{@render row(
				child,
				depth + 1,
				child.name
			)}{/each}
	{/if}
{/snippet}

<Stack as="nav" gap="none" size="fill" aria-label={t('Source')}>
	<Scroll name={t('Source')} size="fill" class="py-1">
		<div role="tree" data-file-tree class="relative w-full min-w-0 px-1">
			{#if needle !== ''}
				{#each matches as path (path)}{@render row(
						{ name: path, path, dir: false },
						0,
						path
					)}{:else}
					<p class="px-3 py-2 text-meta">{t('No matches.')}</p>{/each}
			{:else}
				{#each children('') as node (node.path)}{@render row(node, 0, node.name)}{:else}
					<p class="px-3 py-2 text-meta">{t('No source files')}</p>{/each}
			{/if}
		</div>
	</Scroll>
</Stack>
