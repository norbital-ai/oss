<script lang="ts" module>
	import type { Snippet } from 'svelte';

	export interface WorkspaceShellFrameProps {
		navigation: Snippet;
		children: Snippet;
		mobileTitle: string;
		mobileDescription?: string;
		mobileActions?: Snippet;
		navigationLabel?: string;
		persistenceKey?: string;
		defaultExpanded?: boolean;
		sidebarWidth?: string;
		sidebarWidthIcon?: string;
		collapsible?: 'offcanvas' | 'icon' | 'none';
		side?: 'left' | 'right' | undefined;
		class?: string;
		sidebarClass?: string;
		mobileSidebarClass?: string;
		insetClass?: string;
		contentClass?: string;
	}
</script>

<script lang="ts">
	import * as Sidebar from '#lib/sidebar';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Bound, Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { PersistedState } from 'runed';

	const { t } = useI18n<UiKeys>();

	let {
		navigation,
		children,
		mobileTitle,
		mobileDescription = t('misc.frameMobileDescription'),
		mobileActions,
		navigationLabel = t('misc.primaryNavigation'),
		persistenceKey = 'workspace-shell.expanded',
		defaultExpanded = true,
		sidebarWidth = '16rem',
		sidebarWidthIcon = '3rem',
		collapsible = 'offcanvas',
		side = 'left',
		class: className,
		sidebarClass,
		mobileSidebarClass,
		insetClass,
		contentClass
	}: WorkspaceShellFrameProps = $props();

	// The persistence identity is intentionally fixed for the lifetime of a mounted shell.
	// svelte-ignore state_referenced_locally
	const expanded = new PersistedState(persistenceKey, defaultExpanded);
	const providerStyle = $derived(
		`--sidebar-width:${sidebarWidth};--sidebar-width-icon:${sidebarWidthIcon};`
	);
</script>

<Sidebar.Provider
	bind:open={expanded.current}
	style={providerStyle}
	class={cn(className, 'h-dvh min-h-0 overflow-clip')}
	data-workspace-shell-frame
>
	<Sidebar.Root
		{side}
		{collapsible}
		mobileSide={side}
		{mobileTitle}
		{mobileDescription}
		closeOnNavigate={true}
		aria-label={navigationLabel}
		class={sidebarClass}
		mobileClass={mobileSidebarClass}
	>
		{@render navigation()}
	</Sidebar.Root>

	<Sidebar.Inset as="main" class={cn(insetClass, 'h-dvh min-h-0 min-w-0 overflow-clip')}>
		<!-- stupidity:allow UI15 -- mobile shell chrome includes the device safe-area inset by definition -->
		<Inline
			as="header"
			gap="sm"
			shrink={false}
			class="h-[calc(3.25rem+env(safe-area-inset-top))] border-b bg-background px-[max(0.75rem,env(safe-area-inset-left))] pt-[env(safe-area-inset-top)] md:hidden"
		>
			<Sidebar.Trigger
				aria-label={t('misc.openNavigation', { navigation: navigationLabel.toLowerCase() })}
				class="size-11"
			/>
			<p class="min-w-0 flex-1 truncate text-sm font-medium">{mobileTitle}</p>
			{#if mobileActions}
				<Inline gap="xs" shrink={false}>{@render mobileActions()}</Inline>
			{/if}
		</Inline>
		<Bound
			size="full"
			clip
			grow
			class={cn(contentClass, 'pb-[env(safe-area-inset-bottom)] md:pb-0')}
		>
			{@render children()}
		</Bound>
	</Sidebar.Inset>
</Sidebar.Provider>
