<script lang="ts">
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { SLIDING_INDICATOR_EXPAND_TRANSITION_CLASS } from '#lib/sliding-indicator';
	import { getDefaultFileTreeEntryIcon } from './file-tree-icons';
	import FileTreeNode from './file-tree-node.svelte';
	import FileTreeNodeRow from './file-tree-node-row.svelte';
	import type { FileTreeEntry, FileTreeProps } from './file-tree.types';

	type Props = Omit<FileTreeProps, 'entries' | 'class'> & {
		entry: FileTreeEntry;
		depth?: number;
	};

	let {
		entry,
		onToggle,
		onSelect,
		canDelete,
		onDelete,
		deleteDisabled = false,
		selectedPath = null,
		presenceByPath = {},
		getEntryIcon = getDefaultFileTreeEntryIcon,
		getEntryBadge,
		isMutedEntry,
		variant = 'default',
		depth = 0
	}: Props = $props();

	let open = $state(false);
	let children: FileTreeEntry[] = $state([]);
	let loading = $state(false);
	let loadError = $state('');
	const { t } = useI18n<UiKeys>();

	const isDark = $derived(variant === 'dark');
	const isDirectory = $derived(entry.type === 'directory');
	const isSelected = $derived(selectedPath === entry.path);
	const isMuted = $derived(isMutedEntry?.(entry) ?? entry.writable === false);
	const displayName = $derived(entry.name || entry.path.split('/').pop() || t('misc.unnamed'));
	const presencePeers = $derived(presenceByPath[entry.path] ?? []);
	const entryIcon = $derived(getEntryIcon(entry, { open }));
	const entryBadge = $derived(getEntryBadge?.(entry) ?? null);
	const showDelete = $derived(
		entry.type === 'file' && Boolean(canDelete?.(entry.path, entry) && onDelete)
	);
	const emptyMessage = $derived(loadError || t('misc.emptyFolder'));
	const emptyClass = $derived(
		cn('py-1.5 pr-2 text-xs italic', isDark ? 'text-[#858585]' : 'text-muted-foreground')
	);

	async function loadChildren(): Promise<void> {
		if (!onToggle || loading) return;
		loading = true;
		loadError = '';
		try {
			children = await onToggle(entry.path);
		} catch (error) {
			loadError = error instanceof Error ? error.message : t('misc.failedToLoadFolder');
			children = [];
		} finally {
			loading = false;
		}
	}

	async function toggleDirectory(): Promise<void> {
		if (loading) return;
		if (open) {
			open = false;
			return;
		}
		if (children.length === 0) {
			await loadChildren();
		}
		open = true;
	}

	async function handleRowClick(): Promise<void> {
		if (isDirectory) {
			await toggleDirectory();
			return;
		}
		onSelect?.(entry.path, entry);
	}

	function handleDeleteClick(event: MouseEvent): void {
		event.stopPropagation();
		onDelete?.(entry.path, entry);
	}
</script>

<FileTreeNodeRow
	{entry}
	{isDark}
	{isDirectory}
	{isSelected}
	{isMuted}
	{open}
	{loading}
	{displayName}
	{presencePeers}
	{entryIcon}
	{entryBadge}
	{showDelete}
	{deleteDisabled}
	{depth}
	onRowClick={() => void handleRowClick()}
	onDeleteClick={handleDeleteClick}
/>

{#if isDirectory}
	<div
		class={SLIDING_INDICATOR_EXPAND_TRANSITION_CLASS}
		data-file-tree-collapse=""
		style:grid-template-rows={open ? '1fr' : '0fr'}
	>
		<!-- stupidity:allow UI5 -- collapse-animation wrapper clips during height transitions -->
		<div class="overflow-hidden min-h-0">
			{#if children.length > 0}
				{#each children as child (child.path)}
					<FileTreeNode
						entry={child}
						{onToggle}
						{onSelect}
						{canDelete}
						{onDelete}
						{deleteDisabled}
						{selectedPath}
						{presenceByPath}
						{getEntryIcon}
						{getEntryBadge}
						{isMutedEntry}
						{variant}
						depth={depth + 1}
					/>
				{/each}
			{:else if open && !loading}
				<p class={emptyClass} style="padding-left: {1.125 + depth * 0.625}rem">
					{emptyMessage}
				</p>
			{/if}
		</div>
	</div>
{/if}
