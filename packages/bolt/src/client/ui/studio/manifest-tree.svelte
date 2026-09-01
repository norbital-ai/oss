<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { FileTree, type FileTreeEntry } from '@norbital-ai/ui/file-tree';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { cn } from '@norbital-ai/ui/utils';
	import { WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import {
		MANIFEST_SECTION_MESSAGES,
		sourceTreeChildren,
		sourceTreeMatches,
		type WorkbenchView,
		type ManifestSection,
		type SourceTreeEntry
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		sections = [],
		files = [],
		fileSizes = {},
		view = 'manifest',
		selected = 'collections',
		expanded = [],
		onselect,
		ontoggle
	}: {
		sections?: ReadonlyArray<ManifestSection>;
		files?: ReadonlyArray<string>;
		fileSizes?: Readonly<Record<string, number>>;
		view?: WorkbenchView;
		selected?: string;
		expanded?: ReadonlyArray<string>;
		onselect?: (key: string) => void;
		ontoggle?: (id: string) => void;
	} = $props();
	const { t } = useI18n();

	let searchQuery = $state('');

	const selectedKind = $derived(selected.split(':')[0] ?? '');
	const selectedName = $derived(selected.slice(selectedKind.length + 1));
	const selectedSourcePath = $derived(
		selected.startsWith('source:') ? selected.slice('source:'.length) : null
	);
	const filtering = $derived(searchQuery.trim() !== '');
	const sectionRegionId = (id: string): string =>
		`manifest-tree-${id.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`;
	const sectionLabel = (id: ManifestSection['id']): string => t(MANIFEST_SECTION_MESSAGES[id][0]);
	const emptySectionLabel = (id: ManifestSection['id']): string =>
		t(MANIFEST_SECTION_MESSAGES[id][2]);

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
</script>

<Stack as="nav" gap="none" fill aria-label={t('bolt.studio.navigator')}>
	<div class="h-full min-h-0" class:hidden={view !== 'manifest'} aria-hidden={view !== 'manifest'}>
		<Scroll name={t('bolt.studio.manifest')} layout="stack" gap="none" grow class="min-h-0 py-1">
			{#each sections as section (section.id)}
				{@const expandable = section.id === 'collections'}
				{@const open = expandable && expanded.includes(section.id)}
				{@const regionId = sectionRegionId(section.id)}
				<Stack gap="none">
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
							selectedKind === section.id && (!expandable || selectedName === '')
								? 'bg-accent text-foreground'
								: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
						)}
						aria-expanded={expandable ? open : undefined}
						aria-controls={expandable ? regionId : undefined}
						onclick={() => {
							if (expandable) ontoggle?.(section.id);
							onselect?.(section.id);
						}}
					>
						{#if expandable}
							<Icon
								icon="lucide:chevron-right"
								class={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
							/>
						{:else}
							<span class="w-3 shrink-0"></span>
						{/if}
						<ProductIcon name={section.icon} class="size-3.5 shrink-0" />
						<span class={cn('flex-1 truncate', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>
							{sectionLabel(section.id)}
						</span>
						{#if section.entries.length > 0}
							<span
								class="shrink-0 rounded-full bg-muted px-1.5 py-px text-tiny font-semibold tabular-nums"
							>
								{section.entries.length}
							</span>
						{/if}
					</button>

					{#if open}
						<div id={regionId} class="pl-5">
							<div class="border-l border-border/50 pl-2">
								{#each section.entries as entry (entry.name)}
									<button
										type="button"
										class={cn(
											'flex w-full items-center gap-1.5 truncate rounded-sm px-2 py-1 text-left transition-colors',
											selectedKind === section.id && selectedName === entry.name
												? 'bg-accent text-foreground'
												: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
										)}
										title={entry.name}
										onclick={() => onselect?.(`${section.id}:${entry.name}`)}
									>
										<IconWrapper name={entry.icon ?? 'lucide:box'} class="size-3 shrink-0" />
										<span class={cn('truncate', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}
											>{entry.name}</span
										>
									</button>
								{:else}
									<p
										class={cn('px-2 py-1 text-muted-foreground', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}
									>
										{emptySectionLabel(section.id)}
									</p>
								{/each}
							</div>
						</div>
					{/if}
				</Stack>
			{/each}
		</Scroll>
	</div>

	<div
		class="flex h-full min-h-0 flex-col"
		class:hidden={view !== 'editor'}
		aria-hidden={view !== 'editor'}
		data-testid="studio-source-tree"
	>
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
					/>
				{:else}
					<p class={cn('px-3 py-2 text-muted-foreground', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>
						{t('bolt.studio.noSourceFiles')}
					</p>
				{/if}
			</div>
			<div class="min-h-0" class:hidden={!filtering} aria-hidden={!filtering}>
				{#if filterEntries.length > 0}
					<FileTree
						entries={filterEntries}
						onSelect={selectEntry}
						selectedPath={selectedSourcePath}
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
