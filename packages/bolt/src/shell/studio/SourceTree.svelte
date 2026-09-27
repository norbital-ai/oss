<!--
	Studio's source navigator (staging's source-tree + ui file-tree): a header with the file count and a filter, then the
	workspace as a tree — folders fold (closed unless they hold the open file), each row an icon, the name, and a draft mark
	(A added, M modified, D deleted; a folder holding a draft shows a dot) or the file's size. A filter lists matching paths.
-->
<script lang="ts">
	import { Icon } from '@norbital-ai/ui';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { dirtyFolders } from '../studio.ts';

	let { files, base, drafts, selected, onselect, t }: {
		files: readonly string[]; base: { readonly [path: string]: string }; drafts: { readonly [path: string]: string | null };
		selected: string; onselect: (path: string) => void; t: (key: string) => string;
	} = $props();

	type Node = { name: string; path: string; dir: boolean };
	let query = $state('');
	let folds = $state<{ [dir: string]: boolean }>({});
	const needle = $derived(query.trim().toLowerCase());
	const matches = $derived(needle === '' ? [] : files.filter((p) => p.toLowerCase().includes(needle)));

	/** The entries directly under `dir` (`''`: the root): folders first, then files, each by name. */
	function children(dir: string): Node[] {
		const prefix = dir === '' ? '' : `${dir}/`;
		const seen = new Map<string, Node>();
		for (const p of files) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length), slash = rest.indexOf('/');
			const name = slash === -1 ? rest : rest.slice(0, slash);
			if (!seen.has(name)) seen.set(name, { name, path: prefix + name, dir: slash !== -1 });
		}
		return [...seen.values()].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
	}
	const isOpen = (dir: string) => folds[dir] ?? selected.startsWith(`${dir}/`);
	const mark = (path: string): { label: string; tone: string } | null => {
		if (!(path in drafts)) return null;
		if (drafts[path] === null) return { label: 'D', tone: 'text-destructive' };
		return path in base ? { label: 'M', tone: 'text-amber-700 dark:text-amber-300' } : { label: 'A', tone: 'text-emerald-700 dark:text-emerald-300' };
	};
	const dirtyDirs = $derived(dirtyFolders(Object.keys(drafts)));
	const dirty = (dir: string) => dirtyDirs.has(`${dir}/`);
	const size = (path: string) => {
		const n = (drafts[path] ?? base[path] ?? '').length;
		return n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${Math.round(n / 1024)}K` : `${Math.round(n / (1024 * 1024))}M`;
	};
	function icon(node: Node): string {
		const f = node.name.toLowerCase();
		if (node.dir) return isOpen(node.path) ? 'vscode-icons:default-folder-opened' : 'vscode-icons:default-folder';
		if (f === 'package.json') return 'vscode-icons:file-type-npm';
		if (f.startsWith('tsconfig') && f.endsWith('.json')) return 'vscode-icons:file-type-tsconfig';
		if (f.endsWith('.svelte')) return 'vscode-icons:file-type-svelte';
		if (/\.[cm]?ts$/.test(f)) return 'vscode-icons:file-type-typescript';
		if (/\.[cm]?js$/.test(f)) return 'vscode-icons:file-type-js';
		if (f.endsWith('.json')) return 'vscode-icons:file-type-json';
		if (/\.mdx?$/.test(f)) return 'vscode-icons:file-type-markdown';
		if (f.endsWith('.css')) return 'vscode-icons:file-type-css';
		if (f.endsWith('.sql')) return 'vscode-icons:file-type-sql';
		if (/\.ya?ml$/.test(f)) return 'vscode-icons:file-type-yaml';
		if (f.endsWith('.svg')) return 'vscode-icons:file-type-svg';
		return 'vscode-icons:default-file';
	}
</script>

{#snippet row(node: Node, depth: number, label: string)}
	{@const m = node.dir ? (dirty(node.path) ? { label: '·', tone: '' } : null) : mark(node.path)}
	{@const current = !node.dir && node.path === selected}
	<div class="relative min-w-0" role="treeitem" aria-selected={current} aria-expanded={node.dir ? isOpen(node.path) : undefined}>
		{#each { length: depth } as _, i (i)}
			<span class="pointer-events-none absolute inset-y-0 w-px bg-border/50" style="left: {0.625 + i * 0.625 + 0.45}rem" aria-hidden="true"></span>
		{/each}
		<button type="button" title={node.path} aria-current={current}
			class="relative flex w-full min-w-0 items-center gap-1 rounded-md py-1.5 pr-1.5 text-left text-xs leading-none transition-colors hover:bg-muted/50 {current ? 'bg-accent text-accent-foreground' : ''}"
			style="padding-left: {0.625 + depth * 0.625}rem"
			onclick={() => (node.dir ? (folds[node.path] = !isOpen(node.path)) : onselect(node.path))}>
			<span class="grid size-4 shrink-0 place-items-center">
				{#if node.dir}<Icon name="lucide:chevron-right" class="size-3.5 text-muted-foreground transition-transform duration-200 {isOpen(node.path) ? 'rotate-90' : ''}" />{/if}
			</span>
			<Icon name={icon(node)} class="size-3.5 shrink-0" />
			<span class="min-w-0 flex-1 truncate text-sm text-foreground {drafts[node.path] === null ? 'line-through' : ''} {m?.tone ?? ''}">{label}</span>
			{#if m !== null}
				<span class="shrink-0 text-tiny font-semibold tabular-nums {m.tone || 'text-muted-foreground'}">{m.label}</span>
			{:else if !node.dir}
				<span class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{size(node.path)}</span>
			{/if}
		</button>
	</div>
	{#if node.dir && isOpen(node.path)}
		{#each children(node.path) as child (child.path)}{@render row(child, depth + 1, child.name)}{/each}
	{/if}
{/snippet}

<Stack as="nav" gap="none" fill class="min-h-0" aria-label={t('Source')}>
	<Inline gap="xs" shrink={false} class="border-b border-border/60 px-3 py-1.5 text-muted-foreground">
		<Icon name="lucide:file-code-2" class="size-3.5 shrink-0" />
		<span class="shrink-0 truncate text-sm">{t('Source')}</span>
		{#if files.length > 0}<span class="shrink-0 rounded-full bg-muted px-1.5 py-px text-tiny font-semibold tabular-nums">{files.length}</span>{/if}
		<label class="relative ml-auto min-w-0 flex-1">
			<Icon name="lucide:search" class="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 opacity-70" />
			<input type="search" bind:value={query} aria-label={t('Filter source files')} placeholder={t('Filter')}
				class="block h-6 w-full min-w-0 rounded-sm border border-border/60 bg-background py-0 pr-2 pl-6 text-tiny text-foreground placeholder:text-muted-foreground" />
		</label>
	</Inline>
	<Scroll name={t('Source')} grow class="min-h-0 py-1">
		<div role="tree" data-file-tree class="relative w-full min-w-0 px-1">
			{#if needle !== ''}
				{#each matches as path (path)}{@render row({ name: path, path, dir: false }, 0, path)}{:else}
					<p class="px-3 py-2 text-sm text-muted-foreground">{t('No matches.')}</p>{/each}
			{:else}
				{#each children('') as node (node.path)}{@render row(node, 0, node.name)}{:else}
					<p class="px-3 py-2 text-sm text-muted-foreground">{t('No source files')}</p>{/each}
			{/if}
		</div>
	</Scroll>
</Stack>
