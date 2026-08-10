<script lang="ts">
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';
	import * as Avatar from '#lib/avatar';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import * as DropdownMenu from '#lib/dropdown-menu';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline } from '#lib/layout';
	import * as Sidebar from '#lib/sidebar';
	import { Spinner } from '#lib/spinner';
	import { ThemeToggle } from '#lib/theme-toggle';
	import { cn } from '#lib/utils';
	import type {
		WorkspaceImpersonation,
		WorkspaceNavigationModel,
		WorkspaceOrganizationOption
	} from './workspace-shell.types.js';
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
		onStopImpersonating
	}: {
		model: WorkspaceNavigationModel;
		onNavigate?: (href: string) => void;
		onPrefetch?: (href: string) => void;
		onOrganizationChange?: (organizationId: string) => void | Promise<void>;
		onSignOut?: () => void | Promise<void>;
		notifications?: Snippet<[{ expanded: boolean }]>;
		impersonation?: WorkspaceImpersonation | null;
		onImpersonate?: (teamId: string) => void | Promise<void>;
		onStopImpersonating?: () => void | Promise<void>;
	} = $props();

	let switchingOrganizationId = $state<string | null>(null);
	const sidebar = Sidebar.useSidebar()();
	const displayExpanded = $derived(sidebar.isMobile || sidebar.open);
	let signOutPending = $state(false);
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

	async function selectOrganization(organizationId: string): Promise<void> {
		if (
			organizationId === model.activeOrganization.id ||
			!onOrganizationChange ||
			switchingOrganizationId
		) {
			return;
		}
		switchingOrganizationId = organizationId;
		try {
			await onOrganizationChange(organizationId);
		} finally {
			switchingOrganizationId = null;
		}
	}

	async function signOut(): Promise<void> {
		if (!onSignOut || signOutPending) return;
		signOutPending = true;
		try {
			await onSignOut();
		} finally {
			signOutPending = false;
		}
	}

	const impersonationAvailable = $derived(
		Boolean(impersonation && impersonation.isAdmin && impersonation.teams.length > 0)
	);
	const impersonationTeams = $derived(impersonation?.teams ?? []);
	const impersonationActiveTeamId = $derived(
		impersonation && impersonation.isActive
			? (impersonation.activeTeamIds[0] ?? null)
			: null
	);
	let impersonationBusy = $state(false);

	async function selectImpersonationTeam(teamId: string): Promise<void> {
		if (impersonationBusy || teamId === impersonationActiveTeamId || !onImpersonate) return;
		impersonationBusy = true;
		try {
			await onImpersonate(teamId);
		} finally {
			impersonationBusy = false;
		}
	}

	async function stopImpersonating(): Promise<void> {
		if (impersonationBusy || !onStopImpersonating) return;
		impersonationBusy = true;
		try {
			await onStopImpersonating();
		} finally {
			impersonationBusy = false;
		}
	}
</script>

{#snippet organizationAvatar(organization: WorkspaceOrganizationOption)}
	<Avatar.Root class="size-6 shrink-0 rounded-md">
		{#if organization.logoUrl}
			<Avatar.Image src={organization.logoUrl} alt={organization.name} class="object-cover" />
		{/if}
		<Avatar.Fallback identifier={organization.id}>
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
		<Combobox
			value={model.activeOrganization.id}
			options={organizationOptions}
			display={organizationSelection}
			searchPlaceholder={t('misc.searchOrganizations')}
			emptyPlaceholder={t('misc.selectOrganization')}
			preserveOptionOrder={true}
			scrollToSelection={true}
			disabled={switchingOrganizationId !== null || !onOrganizationChange}
			hideChevron={!displayExpanded}
			class={displayExpanded ? 'w-full' : 'w-8'}
			triggerClass={displayExpanded
				? 'h-8 pl-2 pr-1'
				: 'size-8 justify-center p-0 shadow-xs [&>div]:grow-0 [&>div]:py-0'}
			minWidth={256}
			align="start"
			snapToEnds={true}
			onValueChange={(organizationId) => {
				if (organizationId) void selectOrganization(organizationId);
			}}
		/>
	{/key}
{/snippet}

<Sidebar.Indicator />

<Sidebar.Header class="gap-0 p-2">
	<Inline gap="xs" class="h-8">
		{#if displayExpanded}
			<div class="min-w-0 flex-1">{@render organizationSwitcher()}</div>
			<ThemeToggle class="size-8 shrink-0" />
			<Sidebar.Trigger
				target="expansion"
				class="size-8 shrink-0"
				aria-label={sidebar.isMobile
					? t('misc.closeWorkspaceNavigation')
					: t('misc.collapseSidebar')}
			/>
		{:else}
			<div class="group/org relative mx-auto flex size-8 items-center justify-center">
				<div
					class="flex size-8 items-center justify-center transition-opacity group-hover/org:pointer-events-none group-hover/org:opacity-0"
				>
					{@render organizationSwitcher()}
				</div>
				<!-- Hover-only expand affordance; keyboard users keep the org combobox + Cmd/Ctrl+B. -->
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

<Sidebar.Content class="text-xs">
	<WorkspaceSidebarNavigationSection
		label={t('misc.platform')}
		items={model.system}
		open={displayExpanded}
		{onNavigate}
		{onPrefetch}
	/>
	<WorkspaceSidebarNavigationSection
		label={t('misc.applications')}
		items={model.applications}
		open={displayExpanded}
		{onNavigate}
		{onPrefetch}
	/>
</Sidebar.Content>

<Sidebar.Footer class="border-t border-border bg-muted/30 px-2 py-2 text-xs">
	<Sidebar.Menu class="gap-2">
		{#if notifications}
			<Sidebar.MenuItem>{@render notifications({ expanded: displayExpanded })}</Sidebar.MenuItem>
		{/if}
		{#if displayExpanded}
			<div class="px-1 text-tiny font-medium tracking-wide text-muted-foreground uppercase">
				{t('misc.account')}
			</div>
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
								displayExpanded
									? 'h-auto min-h-14 items-start bg-popover px-2 py-2.5'
									: 'size-8 p-0'
							)}
						>
							<Avatar.Root class={displayExpanded ? 'mt-0.5 size-7 shrink-0' : 'size-8'}>
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
									<p class="truncate text-tiny text-muted-foreground capitalize">
										{model.user.role}{model.user.teamLabels.length
											? ` · ${model.user.teamLabels.join(', ')}`
											: ''}
									</p>
								</div>
								<Icon icon="lucide:chevron-up" class="ml-auto size-4 text-muted-foreground" />
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
							{t('misc.roleLabel', { role: model.user.role })}
						</p>
					</div>
					<DropdownMenu.Separator />
					<DropdownMenu.Label
						class="px-2 pt-2 pb-1 text-tiny font-medium tracking-wide text-muted-foreground uppercase"
						>{t('misc.language')}</DropdownMenu.Label
					>
					<DropdownMenu.RadioGroup
						value={i18n.locale}
						onValueChange={(locale) => i18n.setLocale(locale as (typeof i18n.locale))}
					>
						{#each i18n.locales as locale (locale)}
							<DropdownMenu.RadioItem value={locale}>
								{t(`misc.localeName.${locale}` as UiKeys)}
							</DropdownMenu.RadioItem>
						{/each}
					</DropdownMenu.RadioGroup>
					{#if impersonationAvailable}
						<DropdownMenu.Separator />
						<DropdownMenu.Label
							class="px-2 pt-2 pb-1 text-tiny font-medium tracking-wide text-muted-foreground uppercase"
							>{t('misc.impersonate')}</DropdownMenu.Label
						>
						<div class="max-h-56 overflow-y-auto overscroll-contain">
							<DropdownMenu.RadioGroup
								value={impersonationActiveTeamId ?? ''}
								onValueChange={(teamId) => void selectImpersonationTeam(teamId)}
							>
								{#each impersonationTeams as team (team.id)}
									<DropdownMenu.RadioItem value={team.id} disabled={impersonationBusy}>
										<span class="truncate">{team.name ?? team.id}</span>
									</DropdownMenu.RadioItem>
								{/each}
							</DropdownMenu.RadioGroup>
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
						class="flex w-full items-center justify-start gap-2 text-xs hover:bg-destructive/10 hover:text-destructive"
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
			<Sidebar.MenuItem><ThemeToggle class="mx-auto size-8" /></Sidebar.MenuItem>
		{/if}
	</Sidebar.Menu>
</Sidebar.Footer>
<Sidebar.Rail />
