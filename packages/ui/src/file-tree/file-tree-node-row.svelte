<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS } from '../workspace-shell/workspace-shell.types.js';
	import type { FileTreeEntry, FileTreeEntryBadge, FileTreePresencePeer } from './file-tree.types';

	type Props = {
		entry: FileTreeEntry;
		isDark: boolean;
		isDirectory: boolean;
		isSelected: boolean;
		isMuted: boolean;
		open: boolean;
		loading: boolean;
		displayName: string;
		presencePeers: readonly FileTreePresencePeer[];
		entryIcon: string;
		entryBadge: FileTreeEntryBadge | null;
		showDelete: boolean;
		deleteDisabled: boolean;
		depth: number;
		onRowClick: () => void;
		onDeleteClick: (event: MouseEvent) => void;
	};

	const { t } = useI18n<UiKeys>();

	let {
		entry,
		isDark,
		isDirectory,
		isSelected,
		isMuted,
		open,
		loading,
		displayName,
		presencePeers,
		entryIcon,
		entryBadge,
		showDelete,
		deleteDisabled,
		depth,
		onRowClick,
		onDeleteClick
	}: Props = $props();

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
		return `${Math.round(bytes / (1024 * 1024))}M`;
	}

	const guideColor = $derived(isDark ? 'bg-[#404040]' : 'bg-border/50');

	const buttonClass = $derived(
		cn(
			'relative z-10 flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-left text-xs leading-none transition-colors duration-150',
			isDirectory && 'cursor-pointer',
			isMuted && !isSelected && 'opacity-55',
			isDark
				? cn('hover:bg-[#2a2d2e]', isSelected && 'text-[#ffffff] opacity-100')
				: cn('hover:bg-muted/50', isSelected && 'text-accent-foreground opacity-100')
		)
	);

	const loaderClass = $derived(
		cn('size-3 animate-spin', isDark ? 'text-[#c5c5c5]' : 'text-muted-foreground')
	);

	const chevronClass = $derived(
		cn(
			'size-3.5 transition-transform duration-200 ease-out',
			open && 'rotate-90',
			isDark ? 'text-[#c5c5c5]' : 'text-muted-foreground'
		)
	);

	const entryIconClass = $derived(
		cn(
			'size-3.5 shrink-0',
			isMuted && !isSelected && 'opacity-70',
			isDirectory && isDark && 'text-[#dcb67a]',
			!isDirectory && isDark && 'text-[#9cdcfe]'
		)
	);

	const overflowCount = $derived(presencePeers.length > 3 ? presencePeers.length - 3 : 0);
	const overflowClass = $derived(
		cn('text-tiny tabular-nums', isDark ? 'text-[#858585]' : 'text-muted-foreground')
	);

	const labelClass = $derived(
		cn(
			'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap',
			WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS,
			isDark ? 'text-[#e8e8e8]' : isMuted ? 'text-muted-foreground' : 'text-foreground',
			isSelected && isDark && 'text-[#ffffff]',
			entryBadge?.class
		)
	);

	const badgeClass = $derived(
		cn(
			'shrink-0 text-tiny font-semibold tabular-nums tracking-wide',
			entryBadge?.class ?? (isDark ? 'text-[#858585]' : 'text-muted-foreground')
		)
	);

	const showFileSize = $derived(entry.type === 'file' && presencePeers.length === 0);

	const sizeClass = $derived(
		cn(
			'shrink-0 font-mono text-xs tabular-nums',
			isDark ? 'text-[#858585]' : 'text-muted-foreground',
			isMuted && 'opacity-70'
		)
	);

	const deleteClass = $derived(
		cn(
			'shrink-0 self-center rounded p-1 opacity-0 transition-opacity group-hover/file-row:opacity-100',
			isDark
				? 'text-[#858585] hover:bg-[#3c3c3c] hover:text-[#f85149]'
				: 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
			'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
			deleteDisabled && 'pointer-events-none opacity-40'
		)
	);
</script>

<Inline
	gap="xs"
	align="stretch"
	class="group/file-row relative min-w-0"
	data-file-tree-selected={isSelected ? 'true' : undefined}
	role="treeitem"
	aria-selected={isSelected}
>
	{#if depth > 0}
		{#each { length: depth } as _, guideIndex (guideIndex)}
			<span
				class={cn('pointer-events-none absolute top-0 bottom-0 w-px', guideColor)}
				style="left: {0.625 + guideIndex * 0.625 + 0.45}rem"
				aria-hidden="true"
			></span>
		{/each}
	{/if}
	<button
		type="button"
		class={buttonClass}
		style="padding-left: {0.625 + depth * 0.625}rem"
		aria-expanded={isDirectory ? open : undefined}
		disabled={loading}
		onclick={() => onRowClick()}
	>
		<span class="inline-flex h-4 w-4 shrink-0 items-center justify-center">
			{#if isDirectory}
				{#if loading}
					<Icon icon="lucide:loader" class={loaderClass} />
				{:else}
					<Icon icon="lucide:chevron-right" class={chevronClass} />
				{/if}
			{/if}
		</span>

		<Icon icon={entryIcon} class={entryIconClass} />

		{#snippet collaborators()}
			{#if presencePeers.length > 0}
				<Inline as="span" gap="xs" shrink={false} aria-label={t('misc.activeCollaborators')}>
					{#each presencePeers.slice(0, 3) as peer, index (`${peer.label}:${index}`)}
						<span
							class="size-2 rounded-full ring-1 ring-background"
							style={`background-color: ${peer.color}`}
							title={peer.label}
						></span>
					{/each}
					{#if overflowCount > 0}
						<span class={overflowClass}>+{overflowCount}</span>
					{/if}
				</Inline>
			{/if}
		{/snippet}

		{@render collaborators()}

		<span class={labelClass} title={displayName}>
			{displayName}
		</span>

		{#if entryBadge}
			<span class={badgeClass} aria-label={t('misc.statusLabel', { status: entryBadge.label })}>
				{entryBadge.label}
			</span>
		{:else if showFileSize}
			<span class={sizeClass}>{formatSize(entry.sizeBytes)}</span>
		{/if}
	</button>

	{#if showDelete}
		<button
			type="button"
			class={deleteClass}
			disabled={deleteDisabled}
			aria-label={t('misc.removeItem', { name: displayName })}
			onclick={onDeleteClick}
		>
			<Icon icon="lucide:trash-2" class="size-3.5" />
		</button>
	{/if}
</Inline>
