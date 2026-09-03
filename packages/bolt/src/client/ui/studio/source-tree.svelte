<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { FileTree, type FileTreeEntry } from '@norbital-ai/ui/file-tree';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { cn } from '@norbital-ai/ui/utils';
	import { WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import {
		sourceTreeChildren,
		sourceTreeEntryBadge,
		sourceTreeMatches,
		type SourceTreeEntry
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		files = [],
		fileSizes = {},
		sourceFiles = {},
		drafts = {},
		selected = '',
		onselect
	}: {
		files?: ReadonlyArray<string>;
		fileSizes?: Readonly<Record<string, number>>;
		sourceFiles?: Readonly<Record<string, string>>;
		drafts?: Readonly<Record<string, string>>;
		selected?: string;
		onselect?: (key: string) => void;
	} = $props();
	const { t } = useI18n();

	let searchQuery = $state('');

	const selectedSourcePath = $derived(
		selected.startsWith('source:') ? selected.slice('source:'.length) : null
	);
	const filtering = $derived(searchQuery.trim() !== '');

	const toFileTreeEntry = (entry: SourceTreeEntry): FileTreeEntry => ({
		name: entry.name,
		type: entry.type,
		path: entry.path,
		sizeBytes: entry.sizeBytes,
		writable: true
	});

	const browseEntries = $derived(sourceTreeChildren(files, '', fileSizes).map(toFileTreeEntry));
	const filterEntries = $derived(
		sourceTreeMatches(files, searchQuery, fileSizes).map(toFileTreeEntry)
	);

	const toggleDirectory = (path: string): Effect.Effect<FileTreeEntry[]> =>
		Effect.succeed(sourceTreeChildren(files, path, fileSizes).map(toFileTreeEntry));

	const selectEntry = (path: string, entry: FileTreeEntry): void => {
		if (entry.type === 'file') onselect?.(`source:${path}`);
	};

	const entryBadge = (entry: FileTreeEntry) => sourceTreeEntryBadge(entry, drafts, sourceFiles);
</script>

<Stack as="nav" gap="none" fill aria-label={t('bolt.studio.navigator')}>
	<div class="flex h-full min-h-0 flex-col" data-testid="studio-source-tree">
		<Inline
			gap="xs"
			shrink={false}
			class="border-b border-border/60 px-3 py-1.5 text-muted-foreground"
		>
			<Icon icon="lucide:file-code-2" class="size-3.5 shrink-0" />
			<span class={cn('shrink-0 truncate', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}
				>{t('bolt.studio.source')}</span
			>
			{#if files.length > 0}
				<span
					class="shrink-0 rounded-full bg-muted px-1.5 py-px text-tiny font-semibold tabular-nums"
				>
					{files.length}
				</span>
			{/if}
			<label class="relative ml-auto flex min-w-0 flex-1 items-center">
				<Icon
					icon="lucide:search"
					class="pointer-events-none absolute left-1.5 size-3 shrink-0 opacity-70"
				/>
				<input
					type="search"
					bind:value={searchQuery}
					aria-label={t('bolt.studio.filterSource')}
					placeholder={t('bolt.studio.filter')}
					class="h-6 w-full min-w-0 rounded-sm border border-border/60 bg-background py-0 pl-6 pr-2 text-tiny text-foreground placeholder:text-muted-foreground"
				/>
			</label>
		</Inline>
		<Scroll name={t('bolt.studio.source')} layout="stack" gap="none" grow class="min-h-0 py-1">
			<div class="min-h-0" class:hidden={filtering} aria-hidden={filtering}>
				{#if browseEntries.length > 0}
					<FileTree
						entries={browseEntries}
						onToggle={toggleDirectory}
						onSelect={selectEntry}
						selectedPath={selectedSourcePath}
						getEntryBadge={entryBadge}
					/>
				{:else}
					<p class={cn('px-3 py-2 text-muted-foreground', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>
						{t('bolt.studio.noSourceFiles')}
					</p>
				{/if}
			</div>
			<div class="min-h-0" class:hidden={!filtering} aria-hidden={filtering}>
				{#if filterEntries.length > 0}
					<FileTree
						entries={filterEntries}
						onSelect={selectEntry}
						selectedPath={selectedSourcePath}
						getEntryBadge={entryBadge}
					/>
				{:else}
					<p class={cn('px-3 py-2 text-muted-foreground', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>
						{t('bolt.studio.noSourceMatches')}
					</p>
				{/if}
			</div>
		</Scroll>
	</div>
</Stack>
