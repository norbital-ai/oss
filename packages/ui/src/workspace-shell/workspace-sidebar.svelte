<script lang="ts">
	import Icon from '@iconify/svelte';
	import { mode, toggleMode } from 'mode-watcher';
	import { onMount, type Snippet } from 'svelte';
	import * as Avatar from '#lib/avatar';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import * as DropdownMenu from '#lib/dropdown-menu';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Effect } from 'effect';
	import { detectShortcutModifier, formatShortcut } from '#lib/keybindings';
	import { Inline } from '#lib/layout';
	import * as Sidebar from '#lib/sidebar';
	import { Spinner } from '#lib/spinner';
	import { Tooltip } from '#lib/tooltip';
	import { cn } from '#lib/utils';
	import {
		WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS,
		type WorkspaceImpersonation,
		type WorkspaceNavigationModel,
		type WorkspaceOrganizationOption
	} from '#lib/workspace-shell/workspace-shell.types';
	import WorkspaceSidebarNavigationSection from './workspace-sidebar-navigation-section.svelte';

	const i18n = useI18n<UiKeys>();
	const { t } = i18n;

	let {
		model,
		onNavigate,
		onPrefetch,
		onOrganizationChange,
		onSignOut,
		notifications,
		impersonation,
		onImpersonate,
		onStopImpersonating,
		onSearch,
		searchLabel,
		searchShortcut,
		agent
	}: {
		model: WorkspaceNavigationModel;
		onNavigate?: (href: string) => void | undefined;
		onPrefetch?: (href: string) => void | undefined;
		onOrganizationChange?: (organizationId: string) => void | Effect.Effect<void>;
		onSignOut?: () => void | Effect.Effect<void>;
		notifications?: Snippet<[{ expanded: boolean }]>;
		impersonation?: WorkspaceImpersonation | null;
		onImpersonate?: (teamId: string) => void | Effect.Effect<void>;
		onStopImpersonating?: () => void | Effect.Effect<void>;
		onSearch?: () => void;
		searchLabel?: string;
		searchShortcut?: string;
		agent?: Snippet<[{ expanded: boolean }]>;
	} = $props();

	let switchingOrganizationId = $state<string | null>(null);
	const sidebar = Sidebar.useSidebar()();
	const displayExpanded = $derived(sidebar.isMobile || sidebar.open);
	let signOutPending = $state(false);
	const runPending = (
		action: () => void | Effect.Effect<void>,
		setPending: (pending: boolean) => void
	): void => {
		setPending(true);
		Effect.runFork(
			Effect.ensuring(
				Effect.suspend(() => action() ?? Effect.void),
				Effect.sync(() => setPending(false))
			)
		);
	};
	const organizationOptions = $derived(
		model.organizations.map((organization) => ({
			value: organization.id,
			label: organization.name
		}))
	);

	function organizationFallback(organization: WorkspaceOrganizationOption): string {
		const words = organization.name.trim().split(/\s+/).filter(Boolean);
		if (words.length > 1) return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
		return organization.name.slice(0, 2).toUpperCase() || '?';
	}

	function selectOrganization(organizationId: string): void {
		if (
			organizationId === model.activeOrganization.id ||
			!onOrganizationChange ||
			switchingOrganizationId
		) {
			return;
		}
		runPending(
			() => onOrganizationChange(organizationId),
			(pending) => (switchingOrganizationId = pending ? organizationId : null)
		);
	}

	function signOut(): void {
		if (!onSignOut || signOutPending) return;
		runPending(onSignOut, (pending) => (signOutPending = pending));
	}

	const impersonationAvailable = $derived(
		Boolean(impersonation && impersonation.isAdmin && impersonation.teams.length > 0)
	);
	const impersonationTeams = $derived(impersonation?.teams ?? []);
	const impersonationOptions = $derived(
		impersonationTeams.map((team) => ({ value: team.id, label: team.name ?? t('misc.unnamed') }))
	);
	const impersonationActiveTeamId = $derived(
		impersonation && impersonation.isActive ? (impersonation.activeTeamIds[0] ?? null) : null
	);
	let impersonationBusy = $state(false);
	const nextLocale = $derived(i18n.locale === 'en' ? 'zh' : 'en');

	function toggleLocale(): void {
		i18n.setLocale(nextLocale);
	}

	let shortcutModifier = $state(detectShortcutModifier());
	onMount(() => {
		shortcutModifier = detectShortcutModifier();
	});
	const sidebarShortcut = $derived(formatShortcut(shortcutModifier, 'B'));

	const isDark = $derived(mode.current === 'dark');
	const nextThemeLabel = $derived(t(isDark ? 'misc.themeName.light' : 'misc.themeName.dark'));

	const withShortcut = (label: string, key: string | undefined): string =>
		key ? `${label} · ${key}` : label;

	function selectImpersonationTeam(teamId: string): void {
		if (impersonationBusy || teamId === impersonationActiveTeamId || !onImpersonate) return;
		runPending(
			() => onImpersonate(teamId),
			(pending) => (impersonationBusy = pending)
		);
	}

	function stopImpersonating(): void {
		if (impersonationBusy || !onStopImpersonating) return;
		runPending(onStopImpersonating, (pending) => (impersonationBusy = pending));
	}
</script>

{#snippet organizationAvatar(organization: WorkspaceOrganizationOption)}
	<Avatar.Root class="size-6 shrink-0 rounded-md">
		{#if organization.logoUrl}
			<Avatar.Image src={organization.logoUrl} alt={organization.name} class="object-cover" />
		{/if}
		<Avatar.Fallback identifier={organization.name}>
			{organizationFallback(organization)}
		</Avatar.Fallback>
	</Avatar.Root>
{/snippet}

{#snippet organizationSelection(organizationId: string)}
	{@const organization =
		model.organizations.find((entry) => entry.id === organizationId) ?? model.activeOrganization}
	<Inline gap="sm" class="min-w-0">
		{@render organizationAvatar(organization)}
		{#if displayExpanded}<span class="min-w-0 flex-1 truncate">{organization.name}</span>{/if}
	</Inline>
{/snippet}

{#snippet organizationSwitcher()}
	{#key sidebar.isMobile}
		{@const { id: activeOrganizationId } = model.activeOrganization}
		<Combobox
			value={activeOrganizationId}
			options={organizationOptions}
			display={organizationSelection}
			searchPlaceholder={t('misc.searchOrganizations')}
			emptyPlaceholder={t('misc.selectOrganization')}
			preserveOptionOrder={true}
			scrollToSelection={true}
			disabled={switchingOrganizationId !== null || !onOrganizationChange}
			hideChevron={true}
			class={displayExpanded ? 'w-full' : 'w-8'}
			triggerClass={displayExpanded
				? 'h-8 px-2'
				: 'size-8 justify-center p-0 shadow-xs [&>div]:grow-0 [&>div]:py-0'}
			minWidth={256}
			align="start"
			onValueChange={(organizationId) => {
				if (organizationId) void selectOrganization(organizationId);
			}}
		/>
	{/key}
{/snippet}

{#snippet searchIcon(extraClass: string)}
	{#if onSearch && searchLabel}
		<Tooltip side="bottom" text={withShortcut(searchLabel, searchShortcut)}>
			{#snippet trigger({ props })}
				<Button
					{...props}
					type="button"
					variant="ghost"
					size="icon"
					class={cn('size-8 shrink-0', extraClass)}
					aria-label={searchShortcut ? `${searchLabel} (${searchShortcut})` : searchLabel}
					onclick={onSearch}
					data-testid="workspace-omni-trigger"
				>
					<Icon icon="lucide:search" class="size-4" />
				</Button>
			{/snippet}
		</Tooltip>
	{/if}
{/snippet}

{#snippet agentNavigation()}
	{#if agent}
		<Sidebar.MenuItem>{@render agent({ expanded: displayExpanded })}</Sidebar.MenuItem>
	{/if}
{/snippet}

<Sidebar.Indicator />

<Sidebar.Header class="gap-0 p-2">
	<Inline gap="xs" class="h-8">
		{#if displayExpanded}
			<div class="min-w-0 flex-1">{@render organizationSwitcher()}</div>
			{@render searchIcon('')}
			<Tooltip
				side="bottom"
				text={sidebar.isMobile
					? t('misc.closeWorkspaceNavigation')
					: withShortcut(t('misc.collapseSidebar'), sidebarShortcut)}
			>
				{#snippet trigger({ props })}
					<Sidebar.Trigger
						{...props}
						target="expansion"
						class="size-8 shrink-0"
						aria-label={sidebar.isMobile
							? t('misc.closeWorkspaceNavigation')
							: t('misc.collapseSidebar')}
					/>
				{/snippet}
			</Tooltip>
		{:else}
			<div class="group/org relative mx-auto flex size-8 items-center justify-center">
				<div
					class="flex size-8 items-center justify-center transition-opacity group-hover/org:pointer-events-none group-hover/org:opacity-0"
				>
					{@render organizationSwitcher()}
				</div>
				<Sidebar.Trigger
					target="expansion"
					tabindex={-1}
					class="pointer-events-none absolute inset-0 size-8 opacity-0 group-hover/org:pointer-events-auto group-hover/org:opacity-100"
					aria-label={t('misc.expandSidebar')}
				/>
			</div>
		{/if}
	</Inline>
</Sidebar.Header>

<Sidebar.Content class="gap-0 text-xs">
	{#each model.sections as section (section.key)}
		<WorkspaceSidebarNavigationSection
			label={section.label}
			items={section.items}
			open={displayExpanded}
			href={section.href}
			leading={section.key === 'operations' ? agentNavigation : undefined}
			class={section.key === 'workspace' ? 'mt-auto' : undefined}
			{onNavigate}
			{onPrefetch}
		/>
	{/each}
</Sidebar.Content>

<Sidebar.Footer class="border-t border-border bg-muted/30 px-2 py-1.5 text-xs">
	<Sidebar.Menu class="gap-1.5">
		{#if displayExpanded}
			<Inline justify="between" align="center" gap="xs" class="h-7 px-1">
				<div class={WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS}>{t('misc.account')}</div>
				{#if notifications}
					<Sidebar.MenuItem class="-mr-1">
						{@render notifications({ expanded: true })}
					</Sidebar.MenuItem>
				{/if}
			</Inline>
		{:else if notifications}
			<Sidebar.MenuItem>{@render notifications({ expanded: false })}</Sidebar.MenuItem>
		{/if}
		<Sidebar.MenuItem>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Sidebar.MenuButton
							{...props}
							size="lg"
							aria-label={t('misc.openAccountMenu')}
							class={cn(
								'overflow-visible rounded-md text-xs hover:bg-accent data-[state=open]:bg-accent',
								displayExpanded ? 'h-11 items-center bg-popover px-2 py-1.5' : 'size-8 p-0'
							)}
						>
							<Avatar.Root class={displayExpanded ? 'size-6 shrink-0' : 'size-8'}>
								{#if model.user.avatarUrl}
									<Avatar.Image src={model.user.avatarUrl} alt={model.user.name} />
								{/if}
								<Avatar.Fallback identifier={model.user.email}>
									{model.user.name.slice(0, 1).toUpperCase()}
								</Avatar.Fallback>
							</Avatar.Root>
							{#if displayExpanded}
								<div class="min-w-0 flex-1 text-left">
									<p class="truncate text-xs font-medium">{model.user.name}</p>
									<p class="truncate text-tiny text-muted-foreground">{model.user.email}</p>
								</div>
								<Icon icon="lucide:chevron-up" class="ml-auto size-3.5 text-muted-foreground" />
							{/if}
						</Sidebar.MenuButton>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content
					side={displayExpanded ? 'top' : 'right'}
					align={displayExpanded ? 'center' : 'start'}
					sideOffset={8}
					class="w-72"
				>
					<div class="px-2 py-1.5">
						<p class="text-xs font-medium">{model.user.name}</p>
						<p class="text-tiny text-muted-foreground">{model.user.email}</p>
						<p class="text-tiny text-muted-foreground capitalize">
							{t('misc.roleLabel', { role: model.user.role })}{model.user.teamLabels.length
								? ` · ${model.user.teamLabels.join(', ')}`
								: ''}
						</p>
					</div>
					<DropdownMenu.Separator />
					<Button
						type="button"
						variant="ghost"
						class="h-9 w-full justify-start gap-2 px-2 text-xs"
						onclick={toggleLocale}
					>
						<Icon icon="lucide:languages" class="size-3.5" />
						<span>{t('misc.language')}</span>
						<span class="ml-auto text-muted-foreground">
							{t(`misc.localeName.${nextLocale}` as UiKeys)}
						</span>
					</Button>
					<Button
						type="button"
						variant="ghost"
						class="h-9 w-full justify-start gap-2 px-2 text-xs"
						aria-label={t(isDark ? 'misc.switchToLightMode' : 'misc.switchToDarkMode')}
						onclick={() => toggleMode()}
						data-testid="workspace-theme-toggle"
					>
						<Icon icon={isDark ? 'lucide:sun' : 'lucide:moon'} class="size-3.5" />
						<span>{t('misc.appearance')}</span>
						<span class="ml-auto text-muted-foreground">{nextThemeLabel}</span>
					</Button>
					{#if impersonationAvailable}
						<DropdownMenu.Separator />
						<div class="px-2 pt-2 pb-1 {WORKSPACE_SIDEBAR_SECTION_TEXT_CLASS}">
							{t('misc.impersonate')}
						</div>
						<div class="px-1 pb-1">
							<Combobox
								value={impersonationActiveTeamId}
								options={impersonationOptions}
								searchPlaceholder={t('misc.impersonate')}
								emptyPlaceholder={t('misc.impersonate')}
								preserveOptionOrder={true}
								disabled={impersonationBusy}
								class="w-full"
								triggerClass="h-9 text-xs"
								onValueChange={(teamId) => {
									if (teamId) void selectImpersonationTeam(teamId);
								}}
							/>
						</div>
						{#if impersonation?.isActive}
							<DropdownMenu.Item
								class="gap-2 text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
								disabled={impersonationBusy}
								onclick={() => void stopImpersonating()}
							>
								<Icon icon="lucide:user-x" class="size-3.5" />
								<span>{t('misc.stopImpersonating')}</span>
							</DropdownMenu.Item>
						{/if}
					{/if}
					<DropdownMenu.Separator />
					<Button
						type="button"
						variant="ghost"
						class="h-9 w-full justify-start gap-2 px-2 text-xs hover:bg-destructive/10 hover:text-destructive"
						disabled={!onSignOut || signOutPending}
						onclick={() => void signOut()}
					>
						<Icon icon="lucide:log-out" class="size-3.5" />
						<span>{t('misc.logout')}</span>
						{#if signOutPending}<Spinner class="ml-auto size-3.5" />{/if}
					</Button>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</Sidebar.MenuItem>
		{#if !displayExpanded}
			<Sidebar.MenuItem>{@render searchIcon('mx-auto')}</Sidebar.MenuItem>
		{/if}
	</Sidebar.Menu>
</Sidebar.Footer>
<Sidebar.Rail />
