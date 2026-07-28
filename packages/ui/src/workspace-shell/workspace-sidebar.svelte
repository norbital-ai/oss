<script lang="ts">
	import Icon from '@iconify/svelte';
	import { tick } from 'svelte';
	import * as Avatar from '#lib/avatar';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import * as DropdownMenu from '#lib/dropdown-menu';
	import * as Sidebar from '#lib/sidebar';
	import { Spinner } from '#lib/spinner';
	import { ThemeToggle } from '#lib/theme-toggle';
	import { cn } from '#lib/utils';
	import type {
		WorkspaceNavigationModel,
		WorkspaceOrganizationOption
	} from './workspace-shell.types.js';
	import WorkspaceSidebarNavigationSection from './workspace-sidebar-navigation-section.svelte';

	let {
		model,
		onNavigate,
		onPrefetch,
		onOrganizationChange,
		onSignOut
	}: {
		model: WorkspaceNavigationModel;
		onNavigate?: (href: string) => void;
		onPrefetch?: (href: string) => void;
		onOrganizationChange?: (organizationId: string) => void | Promise<void>;
		onSignOut?: () => void | Promise<void>;
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
	const switchingOrganization = $derived(
		model.organizations.find((organization) => organization.id === switchingOrganizationId)
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
		await tick();
		try {
			await onOrganizationChange(organizationId);
		} catch (error) {
			switchingOrganizationId = null;
			throw error;
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
</script>

{#if switchingOrganization}
	<div
		class="fixed inset-0 z-50 grid place-items-center bg-background/90"
		role="status"
		aria-live="polite"
		aria-label={`Switching to ${switchingOrganization.name}`}
	>
		<div class="flex items-center gap-3 text-sm font-medium">
			<Spinner class="size-4" />
			<span>Switching to {switchingOrganization.name}</span>
		</div>
	</div>
{/if}

{#snippet organizationAvatar(organization: WorkspaceOrganizationOption)}
	<Avatar.Root class="size-6 shrink-0">
		{#if organization.logoUrl}
			<Avatar.Image src={organization.logoUrl} alt={organization.name} />
		{/if}
		<Avatar.Fallback identifier={organization.id}>
			{organizationFallback(organization)}
		</Avatar.Fallback>
	</Avatar.Root>
{/snippet}

{#snippet organizationSelection(organizationId: string)}
	{@const organization =
		model.organizations.find((entry) => entry.id === organizationId) ?? model.activeOrganization}
	<div class="flex min-w-0 items-center gap-2">
		{@render organizationAvatar(organization)}
		{#if displayExpanded}<span class="min-w-0 flex-1 truncate">{organization.name}</span>{/if}
	</div>
{/snippet}

{#snippet organizationSwitcher()}
	<Combobox
		value={model.activeOrganization.id}
		options={organizationOptions}
		display={organizationSelection}
		searchPlaceholder="Search organizations..."
		emptyPlaceholder="Select organization"
		preserveOptionOrder={true}
		scrollToSelection={true}
		disabled={switchingOrganizationId !== null || !onOrganizationChange}
		hideChevron={!displayExpanded}
		class={displayExpanded ? 'w-full' : 'w-8'}
		triggerClass={displayExpanded ? 'h-8 pl-2 pr-1' : 'size-8 justify-center p-1'}
		minWidth={256}
		align="start"
		snapToEnds={true}
		onValueChange={(organizationId) => {
			if (organizationId) void selectOrganization(organizationId);
		}}
	/>
{/snippet}

<Sidebar.Indicator />

<Sidebar.Header class={cn('gap-0 p-2', !displayExpanded && 'group/sidebar-header')}>
	<div class="flex h-8 items-center gap-0.5">
		{#if displayExpanded}
			<div class="min-w-0 flex-1">{@render organizationSwitcher()}</div>
			<ThemeToggle class="size-8 shrink-0" />
			<Sidebar.Trigger
				target="expansion"
				class="size-8 shrink-0"
				aria-label={sidebar.isMobile ? 'Close workspace navigation' : 'Collapse sidebar'}
			/>
		{:else}
			<div class="relative mx-auto size-8">
				<div
					aria-hidden="true"
					class="pointer-events-none flex size-10 items-center justify-center transition-opacity duration-150 group-hover/sidebar-header:opacity-0 group-focus-within/sidebar-header:opacity-0"
				>
					{@render organizationAvatar(model.activeOrganization)}
				</div>
				<Sidebar.Trigger
					target="expansion"
					class={cn(
						'absolute inset-0 m-auto size-8 transition-opacity duration-150 group-hover/sidebar-header:opacity-100 group-focus-within/sidebar-header:opacity-100 focus-visible:opacity-100',
						sidebar.isMobile ? 'opacity-100' : 'opacity-0'
					)}
					aria-label="Expand sidebar"
				/>
			</div>
		{/if}
	</div>
</Sidebar.Header>

<Sidebar.Content class="overflow-x-hidden text-xs">
	<WorkspaceSidebarNavigationSection
		label="Platform"
		items={model.system}
		open={displayExpanded}
		{onNavigate}
		{onPrefetch}
	/>
	<WorkspaceSidebarNavigationSection
		label="Applications"
		items={model.applications}
		open={displayExpanded}
		{onNavigate}
		{onPrefetch}
	/>
</Sidebar.Content>

<Sidebar.Footer class="border-t border-border bg-muted/30 px-2 py-2 text-xs">
	<Sidebar.Menu class="gap-2">
		{#if displayExpanded}
			<div class="px-1 text-tiny font-medium tracking-wide text-muted-foreground uppercase">
				Account
			</div>
		{/if}
		<Sidebar.MenuItem>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Sidebar.MenuButton
							{...props}
							size="lg"
							aria-label="Open account menu"
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
					class="w-64"
				>
					<div class="px-2 py-1.5">
						<p class="text-xs font-medium">{model.user.name}</p>
						<p class="text-tiny text-muted-foreground">{model.user.email}</p>
						<p class="text-tiny text-muted-foreground capitalize">
							Role: {model.user.role}
						</p>
					</div>
					<DropdownMenu.Separator />
					<Button
						type="button"
						variant="ghost"
						class="flex w-full items-center justify-start gap-2 text-xs hover:bg-destructive/10 hover:text-destructive"
						disabled={!onSignOut || signOutPending}
						onclick={() => void signOut()}
					>
						<Icon icon="lucide:log-out" class="size-3.5" />
						<span>Logout</span>
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
