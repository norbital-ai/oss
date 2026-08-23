<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { FileTree, type FileTreeEntry } from '@norbital-ai/ui/file-tree';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { ProductIcon } from '@norbital-ai/ui/product-icon';
	import { cn } from '@norbital-ai/ui/utils';
	import { WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import {
		sourceTreeChildren,
		sourceTreeMatches,
		type AuthoringView,
		type ManifestSection,
		type SourceTreeEntry
	} from '#lib/client/ui/studio/studio-state.js';

	/**
	 * The authoring navigator: the workspace's own manifest under Manifest, its files under Editor.
	 *
	 * A branch header both selects the branch and opens it, so it is one `<button>` rather than a
	 * collapsible trigger with a second button inside it — that markup is invalid, and it is why
	 * selecting "Apps" used to be impossible without first opening it.
	 *
	 * Only Collections opens. Every other kind is read whole in its own panel, so listing its members
	 * here too would give a reader two controls that land on the same page and one of them would be
	 * the worse read.
	 *
	 * Both trees stay mounted and one is hidden. They share a fixed-width slot, and swapping a short
	 * manifest tree for a measured file tree during navigation is what makes the main viewport jump.
	 */
	let {
		sections = [],
		files = [],
		fileSizes = {},
		view = 'manifest',
		selected = 'collections',
		expanded = [],
		readOnly = false,
		onselect,
		ontoggle
	}: {
		sections?: ReadonlyArray<ManifestSection>;
		files?: ReadonlyArray<string>;
		fileSizes?: Readonly<Record<string, number>>;
		view?: AuthoringView;
		selected?: string;
		expanded?: ReadonlyArray<string>;
		readOnly?: boolean;
		onselect?: (key: string) => void;
		ontoggle?: (id: string) => void;
	} = $props();

	let searchQuery = $state('');

	const selectedKind = $derived(selected.split(':')[0] ?? '');
	const selectedName = $derived(selected.slice(selectedKind.length + 1));
	const selectedSourcePath = $derived(
		selected.startsWith('source:') ? selected.slice('source:'.length) : null
	);
	const filtering = $derived(searchQuery.trim() !== '');

	const toFileTreeEntry = (entry: SourceTreeEntry): FileTreeEntry => ({
		name: entry.name,
		type: entry.type,
		path: entry.path,
		sizeBytes: entry.sizeBytes,
		writable: !readOnly
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

<Stack as="nav" gap="none" fill aria-label="Workspace navigator">
	<div class="h-full min-h-0" class:hidden={view !== 'manifest'} aria-hidden={view !== 'manifest'}>
		<Scroll name="Manifest sections" layout="stack" gap="none" grow class="min-h-0 py-1">
			{#each sections as section (section.id)}
				{@const open = section.expandable && expanded.includes(section.id)}
				<Stack gap="none">
					<button
						type="button"
						class={cn(
							'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
							selectedKind === section.id && (!section.expandable || selectedName === '')
								? 'bg-accent text-foreground'
								: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
						)}
						aria-expanded={section.expandable ? open : undefined}
						onclick={() => {
							if (section.expandable) ontoggle?.(section.id);
							onselect?.(section.id);
						}}
					>
						{#if section.expandable}
							<Icon
								icon="lucide:chevron-right"
								class={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')}
							/>
						{:else}
							<span class="w-3 shrink-0"></span>
						{/if}
						<ProductIcon name={section.icon} class="size-3.5 shrink-0" />
						<span class={cn('flex-1 truncate', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>
							{section.label}
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
						<div class="ml-5 border-l border-border/50 pl-2">
							{#each section.entries as entry (entry.name)}
								<button
									type="button"
									class={cn(
										'flex w-full items-center gap-1.5 truncate rounded-sm px-2 py-1 text-left transition-colors',
										selectedKind === section.id && selectedName === entry.name
											? 'bg-accent text-foreground'
											: 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
									)}
									title={entry.detail ?? entry.name}
									onclick={() => onselect?.(`${section.id}:${entry.name}`)}
								>
									<IconWrapper name={entry.icon ?? 'lucide:box'} class="size-3 shrink-0" />
									<span class={cn('truncate', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>{entry.name}</span
									>
								</button>
							{:else}
								<p class={cn('px-2 py-1 text-muted-foreground', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>
									None declared.
								</p>
							{/each}
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
			<span class={cn('shrink-0 truncate', WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS)}>Source</span>
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
					aria-label="Filter source files"
					placeholder="Filter"
					class="h-6 w-full min-w-0 rounded-sm border border-border/60 bg-background py-0 pl-6 pr-2 text-tiny text-foreground placeholder:text-muted-foreground"
				/>
			</label>
		</Inline>
		<Scroll name="Workspace source" layout="stack" gap="none" grow class="min-h-0 py-1">
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
						None.
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
						No matches.
					</p>
				{/if}
			</div>
		</Scroll>
	</div>
</Stack>
