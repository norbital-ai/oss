<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { FileTree, type FileTreeEntry } from '@norbital-ai/ui/file-tree';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import { sourceTreeChildren, type SourceTreeEntry } from './studio-state.js';
	import type { WorkspaceDocumentationPage } from './workspace-documentation.js';

	let {
		pages,
		sourceFiles,
		selectedPath,
		onselect
	}: {
		pages: readonly WorkspaceDocumentationPage[];
		sourceFiles: Readonly<Record<string, string>>;
		selectedPath: string;
		onselect?: (path: string) => void;
	} = $props();
	const { t } = useI18n();

	const paths = $derived(pages.map((page) => page.path));
	const fileSizes = $derived(
		Object.fromEntries(pages.map((page) => [page.path, (sourceFiles[page.path] ?? '').length]))
	);
	const titles = $derived(new Map(pages.map((page) => [page.path, page.title])));
	const expandedPaths = $derived(
		[
			...new Set(
				paths.flatMap((path) => {
					const parts = path.split('/').slice(0, -1);
					return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
				})
			)
		].sort()
	);

	const humanize = (value: string): string =>
		value.replace(/[-_]+/g, ' ').replace(/\b\p{L}/gu, (character) => character.toUpperCase());

	const toFileTreeEntry = (entry: SourceTreeEntry): FileTreeEntry => ({
		name: entry.type === 'file' ? (titles.get(entry.path) ?? entry.name) : humanize(entry.name),
		type: entry.type,
		path: entry.path,
		sizeBytes: entry.sizeBytes
	});

	const entries = $derived(
		sourceTreeChildren(paths, '', fileSizes).map((entry) => toFileTreeEntry(entry))
	);
	const toggleDirectory = (path: string): Effect.Effect<FileTreeEntry[]> =>
		Effect.succeed(
			sourceTreeChildren(paths, path, fileSizes).map((entry) => toFileTreeEntry(entry))
		);

	const selectEntry = (path: string, entry: FileTreeEntry): void => {
		if (entry.type === 'file') onselect?.(path);
	};
	const entryIcon = (entry: FileTreeEntry, context: { open: boolean }): string =>
		entry.type === 'file'
			? 'lucide:file-text'
			: context.open
				? 'lucide:folder-open'
				: 'lucide:folder';
</script>

<Stack as="nav" gap="none" fill aria-label={t('bolt.studio.documentationNavigator')}>
	<div class="flex h-full min-h-0 flex-col" data-testid="studio-documentation-tree">
		<Inline
			gap="xs"
			shrink={false}
			class="border-b border-border/60 px-3 py-1.5 text-muted-foreground"
		>
			<Icon icon="lucide:book-open" class="size-3.5 shrink-0" />
			<span class="truncate {WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS}"
				>{t('bolt.studio.documentationPages')}</span
			>
			{#if pages.length > 0}
				<span
					class="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-tiny font-semibold tabular-nums"
				>
					{pages.length}
				</span>
			{/if}
		</Inline>
		<Scroll
			name={t('bolt.studio.documentationPages')}
			layout="stack"
			gap="none"
			grow
			class="min-h-0 py-1"
		>
			{#if entries.length > 0}
				<FileTree
					{entries}
					onToggle={toggleDirectory}
					onSelect={selectEntry}
					{selectedPath}
					getEntryIcon={entryIcon}
					defaultExpandedPaths={expandedPaths}
				/>
			{:else}
				<p class="px-3 py-2 text-muted-foreground {WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS}">
					{t('bolt.studio.noDocumentation')}
				</p>
			{/if}
		</Scroll>
	</div>
</Stack>
