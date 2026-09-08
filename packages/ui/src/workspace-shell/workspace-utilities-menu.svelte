<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import * as Popover from '#lib/popover';
	import * as Sidebar from '#lib/sidebar';
	import {
		WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS,
		type WorkspaceNavigationItem
	} from '#lib/workspace-shell/workspace-shell.types';
	import WorkspaceSidebarNavigationLeaf from './workspace-sidebar-navigation-leaf.svelte';

	let {
		items,
		expanded = true,
		onNavigate
	}: {
		/** One segment per entry: the entry's label heads the group, its children are the rows. */
		items: readonly WorkspaceNavigationItem[];
		expanded?: boolean;
		onNavigate?: (href: string) => void | undefined;
	} = $props();

	const { t } = useI18n<UiKeys>();
	let open = $state(false);

	// A branch with no children still deserves a row; it becomes a one-row segment under its own name.
	const segments = $derived(
		items.map((item) => ({ item, rows: item.children?.length ? item.children : [item] }))
	);
	const active = $derived(items.some((item) => item.active));

	// The rows navigate through the leaf, which never tells the popover it moved.
	const navigate = (href: string): void => {
		open = false;
		onNavigate?.(href);
	};
</script>

{#if items.length > 0}
	<Popover.Root bind:open>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Sidebar.MenuButton
					{...props}
					isActive={active}
					aria-label={t('misc.moreDestinations')}
					tooltipContent={t('misc.moreDestinations')}
					class="justify-center rounded-md p-0 hover:bg-accent data-[state=open]:bg-accent {expanded
						? 'size-7'
						: 'size-8'}"
				>
					<Icon icon="lucide:ellipsis" class="size-3.5 shrink-0" />
				</Sidebar.MenuButton>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content
			side={expanded ? 'top' : 'right'}
			align={expanded ? 'end' : 'start'}
			sideOffset={8}
			class="flex w-64 flex-col gap-3 p-2"
		>
			{#each segments as segment (segment.item.key)}
				<div>
					<div class="px-1.5 pb-1 {WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS}">{segment.item.label}</div>
					<ul class="flex min-w-0 flex-col gap-0.5">
						{#each segment.rows as row (row.key)}
							<WorkspaceSidebarNavigationLeaf item={row} onNavigate={navigate} />
						{/each}
					</ul>
				</div>
			{/each}
		</Popover.Content>
	</Popover.Root>
{/if}
