<!--
	The workspace sidebar,  the workspace switcher with the finder and the collapse toggle; the model's
	sections as icon-tile rows (Norbius wears its strip); and the account footer — its label, the environment badge, the
	sync dot, the bell and the Settings/System/Kiosks menu, then the account card whose menu holds language, appearance,
	team preview and sign-out. Collapsed (`expanded` false) it is a 3rem icon rail with tooltips.
-->
<script lang="ts">
	import { fork } from '@norbital-ai/ui/effect';
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import { watch } from 'runed';
	import {
		Badge,
		Button,
		Combobox,
		Icon,
		Popover,
		Spinner,
		Tooltip,
		begin_workspace_navigation,
		cn,
		type ComboboxOption
	} from '@norbital-ai/ui';
	import { FEATURE_COLORS, NorbiusStrip } from '@norbital-ai/ui/brand';
	import { Frame, Imposter, Inline, Stack } from '@norbital-ai/ui/layout';
	import type { SyncStatus } from '../page/bolt.ts';
	import { NORBIUS, type NavItem, type NavModel, type Translate } from './model.ts';
	import Awaiting from './agent/Awaiting.svelte';
	import type { Awaiting as AwaitingKind } from './agent/chime.ts';
	import { based, type ShellNotice } from './nav.ts';
	import { LANGUAGE, LOCALES } from './i18n.ts';
	import { THEMES, type Theme } from './theme.ts';
	import { shortcutLabel } from './keyboard.ts';

	let {
		model,
		pinned = false,
		expanded = true,
		mobile = false,
		t,
		environment = null,
		locale = 'en',
		on_locale,
		theme = 'system',
		on_theme,
		chimes = true,
		awaiting = null,
		on_sounds,
		sync = 'idle',
		previewing = false,
		load_teams,
		on_preview_team,
		on_end_preview,
		on_search,
		on_toggle,
		on_navigate,
		on_sign_out,
		bell,
		notice
	}: {
		model: NavModel;
		/** A shell bound to this workspace (an app): its identity shows without a way to another workspace. */
		pinned?: boolean;
		expanded?: boolean;
		mobile?: boolean;
		t: Translate;
		environment?: string | null;
		locale?: string;
		on_locale?: (locale: string) => void;
		theme?: Theme;
		on_theme?: (theme: Theme) => void;
		chimes?: boolean;
		/** What Norbius left unseen: a dot on its icon. */
		awaiting?: AwaitingKind | null;
		on_sounds?: () => void;
		sync?: SyncStatus;
		/** A preview runs: the menu offers its end. `load_teams` is an administrator's: the teams a preview may take. */
		previewing?: boolean;
		load_teams?: () => Promise<readonly { id: string; name: string }[]>;
		on_preview_team?: (team: string) => void;
		on_end_preview?: () => void;
		on_search?: () => void;
		on_toggle?: () => void;
		on_navigate: (href: string) => void;
		on_sign_out: () => Effect.Effect<void>;
		/** The notification bell (it reads the live inbox the shell owns). */
		bell?: Snippet<[boolean]>;
		/** The host's notice (a billing reminder): a footer line here, so it never takes the page's height. */
		notice?: ShellNotice | undefined;
	} = $props();

	const base = $derived(LOCALES.find((l) => locale.startsWith(l)) ?? 'en');
	const nextLocale = $derived(LOCALES[(LOCALES.indexOf(base) + 1) % LOCALES.length] ?? LOCALES[0]);
	// the versions `bolt build` bakes into the client (L-BOLT-073); absent when the shell is mounted unbuilt (tests)
	const build = typeof __BOLT_BUILD__ === 'undefined' ? null : __BOLT_BUILD__;
	const mod = shortcutLabel('');
	const withKey = (label: string, key: string) => `${label} · ${mod}${key}`;
	const THEME_ICON: { readonly [x in Theme]: string } = {
		light: 'lucide:sun',
		dark: 'lucide:moon',
		system: 'lucide:monitor'
	};
	const THEME_LABEL: { readonly [x in Theme]: string } = {
		light: 'Light',
		dark: 'Dark',
		system: 'System'
	};
	// `idle` is the stream nobody asked for (no live read is open), not a failure; `connecting` is opening or retrying a drop
	const SYNC: { readonly [s in SyncStatus]: { dot: string; label: string } } = {
		live: { dot: 'bg-success', label: 'Connected' },
		connecting: { dot: 'animate-pulse bg-muted-foreground/60', label: 'Reconnecting' },
		idle: { dot: 'bg-muted-foreground/40', label: 'Idle' },
		closed: { dot: 'bg-destructive', label: 'Connection closed' }
	};

	const follow = (event: MouseEvent, href: string) => {
		event.preventDefault();
		on_navigate(href);
	};
	/** The avatar fallback's hue comes from the member identifier. */
	const hue = (s: string) =>
		`hsl(${Math.abs([...s].reduce((h, c) => c.charCodeAt(0) + ((h << 5) - h), 0)) % 360} 65% 55%)`;
	const initials = (name: string) => {
		const [first, second] = name.trim().split(/\s+/).filter(Boolean);
		return (
			(first !== undefined && second !== undefined ? first.charAt(0) + second.charAt(0) : name.slice(0, 2)).toUpperCase() || '?'
		);
	};
	// the current workspace heads the list, so the switcher shows which one is open
	const workspaceOptions: readonly ComboboxOption[] = $derived([
		...(model.workspace.handle === null
			? []
			: [{ value: model.workspace.handle, label: model.workspace.name }]),
		...model.workspace.others.map((w) => ({ value: w.handle, label: w.name }))
	]);
	// another workspace is a full load: it leaves this one through the host's handoff
	const switchWorkspace = (handle: string | null) => {
		const next = model.workspace.others.find((w) => w.handle === handle);
		if (next === undefined) return;
		begin_workspace_navigation(t('Opening workspace…'));
		location.assign(next.href);
	};

	// a row with children is a disclosure, open while it or a descendant holds the active page
	const hasActive = (item: NavItem): boolean =>
		item.active || (item.children?.some((child) => hasActive(child)) ?? false);
	const activeGroups = (items: readonly NavItem[]): string[] =>
		items.flatMap((item) =>
			item.children === undefined
				? []
				: [...(hasActive(item) ? [item.key] : []), ...activeGroups(item.children)]
		);
	let open = $state<{ [key: string]: boolean }>({});
	watch(
		() => model.sections.flatMap((s) => activeGroups(s.items)),
		(keys) => {
			for (const k of keys) open[k] = true;
		}
	);

	let menuOpen = $state(false),
		moreOpen = $state(false);
	let teams = $state<Promise<readonly { id: string; name: string }[]> | null>(null);
	let signingOut = $state(false);
	function sign_out(): void {
		signingOut = true;
		fork(
			Effect.suspend(on_sign_out).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						signingOut = false;
					})
				)
			)
		);
	}

	const ROW =
		'relative flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md text-left outline-hidden ring-sidebar-ring transition-[width,height,padding] focus-visible:ring-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground';
	const SUB =
		'flex h-7 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md py-0 pr-2 pl-1.5 text-left text-xs text-sidebar-foreground outline-hidden ring-sidebar-ring focus-visible:ring-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground';
	const LABEL = 'min-w-0 flex-1 truncate text-xs font-normal sm:text-micro';
	const TOOL = 'size-8 rounded-md p-0 hover:bg-accent data-[state=open]:bg-accent';
</script>

{#snippet avatar(name: string, identifier: string, logo: string | null, size: string)}
	<Frame ratio="square" class={cn('rounded-full text-tiny font-medium', size)}>
		{#if logo}<img src={logo} alt="" class="size-full rounded-md object-cover" />
		{:else}<Inline
				as="span"
				justify="center"
				class="size-full rounded-full"
				style="background-color: {hue(identifier)}">{name}</Inline
			>{/if}
	</Frame>
{/snippet}

{#snippet tile(item: NavItem)}
	{@const color = item.feature_color === undefined ? null : FEATURE_COLORS[item.feature_color]}
	<!-- relative: a Frame fits its children, so the pill sits on this wrapper, over the tile's corner -->
	<span class="relative inline-flex shrink-0">
		<Frame
			ratio="square"
			class={cn(
				'size-6 rounded-md border shadow-xs',
				color?.iconWrapperClass ?? 'border-input bg-background text-foreground'
			)}
		>
			{#if item.href === NORBIUS}<span class="relative inline-flex"
					><NorbiusStrip size={20} /><Awaiting kind={awaiting} {t} /></span
				>
			{:else}<Icon
					name={item.icon ?? 'lucide:layout-grid'}
					class={cn('size-3.5', color?.icon_class)}
				/>{/if}
		</Frame>
		{#if item.badge}
			<!-- the bell's count pill: the same badge for approvals as for notifications -->
			<Imposter
				as="span"
				placement="top-end"
				data-testid="nav-count-badge"
				class="-top-1 -right-1 z-auto min-w-3.5 rounded-full bg-primary px-1 text-center text-[8px] leading-3.5 font-medium text-primary-foreground"
				aria-hidden="true">{Number(item.badge) > 99 ? '99+' : item.badge}</Imposter
			>
		{/if}
	</span>
{/snippet}

{#snippet tip(
	text: string,
	side: 'right' | 'bottom' | 'top',
	disabled: boolean,
	trigger: Snippet<[{ props: Record<string, unknown> }]>
)}
	<Tooltip {side} {text} {disabled} {trigger} />
{/snippet}

{#snippet itemControl(item: NavItem, nested: boolean, props: Record<string, unknown>)}
	{@const disclosure = (nested || expanded) && item.children !== undefined}
	<svelte:element
		this={disclosure ? 'button' : 'a'}
		{...props}
		type={disclosure ? 'button' : undefined}
		href={disclosure ? undefined : based(item.href)}
		aria-current={!disclosure && item.active ? 'page' : undefined}
		aria-expanded={disclosure ? open[item.key] === true : undefined}
		aria-haspopup={!nested && item.href === NORBIUS ? 'dialog' : undefined}
		data-active={item.active && (nested || !disclosure) ? 'true' : undefined}
		data-testid={!nested && item.href === NORBIUS ? 'workspace-agent-trigger' : undefined}
		class={nested ? SUB : cn(ROW, expanded ? 'h-7 p-2 pr-7' : 'size-8 justify-center p-1')}
		onclick={(e: MouseEvent) => {
			if (nested) moreOpen = false;
			if (disclosure) open[item.key] = !open[item.key];
			else follow(e, item.href);
		}}
	>
		{#if !nested && item.active && !disclosure}<span
				class="absolute top-1/4 left-0.5 h-1/2 w-0.5 rounded-lg bg-brand"
				aria-hidden="true"
			></span>{/if}
		{#if nested}
			<Frame as="span" ratio="square" class="size-6"
				><Icon name={item.icon ?? (disclosure ? 'lucide:folder' : 'lucide:file')} class="size-3.5" /></Frame
			>
		{:else}{@render tile(item)}{/if}
		{#if nested || expanded}
			<span class={LABEL}>{item.label}</span>
			{#if !nested && item.href === NORBIUS}
				<kbd
					class="pointer-events-none absolute top-1/2 right-2 hidden h-5 -translate-y-1/2 rounded-md border border-border bg-muted px-1.5 py-px font-mono text-tiny leading-4 font-medium text-muted-foreground select-none sm:inline-block"
					aria-hidden="true">{mod}K</kbd
				>
			{:else if item.children !== undefined}
				<Icon
					name="lucide:chevron-right"
					class={cn(
						nested
							? 'ml-auto size-3 transition-transform duration-150'
							: 'pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 transition-transform duration-150',
						open[item.key] && 'rotate-90'
					)}
				/>
			{/if}
			{#if nested && !disclosure && item.badge}<Badge variant="outline" class="px-1.5 py-0 text-tiny leading-4 font-medium"
					>{item.badge}</Badge
				>{/if}
		{/if}
	</svelte:element>
{/snippet}

{#snippet branch(item: NavItem, nested = false)}
	<li class={nested ? undefined : 'relative'}>
		{#if nested}
			{@render itemControl(item, true, {})}
		{:else}
			{#snippet link({ props }: { props: Record<string, unknown> })}
				{@render itemControl(item, false, props)}
			{/snippet}
			{@render tip(
				item.href === NORBIUS ? withKey(item.label, 'K') : item.label,
				'right',
				expanded || mobile,
				link
			)}
		{/if}
		{#if (nested || expanded) && item.children !== undefined && open[item.key]}
			<Stack as="ul" gap="xs" class={nested
				? 'mr-0 ml-4 border-l border-sidebar-border py-0.5 pr-0 pl-2'
				: 'mr-0 ml-5 border-l border-sidebar-border py-0.5 pr-0 pl-2'}>
				{#each item.children as child (child.key)}{@render branch(child, true)}{/each}
			</Stack>
		{/if}
	</li>
{/snippet}

{#snippet searchButton(extra: string)}
	{#if on_search !== undefined}
		{#snippet trigger({ props }: { props: Record<string, unknown> })}
			<Button
				{...props}
				type="button"
				variant="ghost"
				size="icon"
				class={cn('shrink-0', extra)}
				aria-label={`${t('Find')} (${mod}/)`}
				onclick={on_search}
				data-testid="workspace-omni-trigger"
			>
				<Icon name="lucide:search" class="size-4" />
			</Button>
		{/snippet}
		{@render tip(withKey(t('Find'), '/'), expanded ? 'bottom' : 'right', mobile, trigger)}
	{/if}
{/snippet}

{#snippet toggle(extra: string, tabindex: number | undefined)}
	{#if on_toggle !== undefined}
		{#snippet trigger({ props }: { props: Record<string, unknown> })}
			<Button
				{...props}
				type="button"
				variant="ghost"
				size="icon"
				{tabindex}
				class={cn('shrink-0', extra)}
				data-sidebar="trigger"
				aria-label={t(expanded ? 'Collapse sidebar' : 'Expand sidebar')}
				onclick={on_toggle}
			>
				<Icon name="lucide:panel-left" class="size-4" />
			</Button>
		{/snippet}
		{@render tip(
			withKey(t(expanded ? 'Collapse sidebar' : 'Expand sidebar'), 'B'),
			'bottom',
			!expanded,
			trigger
		)}
	{/if}
{/snippet}

{#snippet switcher()}
	<!-- one workspace has nowhere to switch to -->
	{#if pinned || model.workspace.others.length === 0}
		<div
			data-testid="workspace-identity"
			class={cn(
				'flex min-w-0 items-center gap-2 text-sm',
				expanded ? 'h-8 w-full px-2' : 'size-8 justify-center p-0'
			)}
		>
			{@render avatar(
				initials(model.workspace.name),
				model.workspace.name,
				model.workspace.logo,
				'size-6'
			)}
			{#if expanded}<span class="min-w-0 flex-1 truncate text-left text-xs font-medium"
					>{model.workspace.name}</span
				>{/if}
		</div>
	{:else}
		<Combobox
			value={model.workspace.handle}
			options={workspaceOptions}
			searchable
			aria-label={t('Switch workspace')}
			class={expanded ? 'h-8 w-full px-2' : 'size-8 shrink-0 justify-center gap-0 p-0'}
			on_change={switchWorkspace}
		>
			{#snippet trigger(option)}
				{@render avatar(
					initials(option?.label ?? model.workspace.name),
					(option?.value ?? null) === model.workspace.handle
						? model.workspace.name
						: (option?.value ?? model.workspace.name),
					(option?.value ?? null) === model.workspace.handle ? model.workspace.logo : null,
					'size-6'
				)}
				{#if expanded}<span class="min-w-0 flex-1 truncate text-left text-xs font-medium"
						>{option?.label ?? model.workspace.name}</span
					>{/if}
			{/snippet}
			{#snippet lead(option)}
				{@render avatar(
					initials(option.label),
					option.value === model.workspace.handle ? model.workspace.name : option.value,
					option.value === model.workspace.handle ? model.workspace.logo : null,
					'size-6'
				)}
			{/snippet}
		</Combobox>
	{/if}
{/snippet}

<nav
	aria-label={t('Workspace navigation')}
	class="flex h-full min-h-0 w-full flex-col overflow-x-hidden bg-sidebar text-xs text-sidebar-foreground"
>
	<div class="shrink-0 p-2">
		{#if expanded}
			<Inline gap="xs" class="h-8">
				<div class="min-w-0 flex-1">{@render switcher()}</div>
				{@render searchButton('')}
				{@render toggle('', undefined)}
			</Inline>
		{:else}
			<!-- collapsed: the workspace mark, swapped for the expand toggle on hover  -->
			<div class="group/org relative mx-auto size-8">
				<div
					class="size-8 transition-opacity group-hover/org:pointer-events-none group-hover/org:opacity-0"
				>
					{@render switcher()}
				</div>
				<Imposter
					placement="fill"
					class="pointer-events-none opacity-0 group-hover/org:pointer-events-auto group-hover/org:opacity-100"
				>
					{@render toggle('', -1)}
				</Imposter>
			</div>
		{/if}
	</div>

	<div
		class={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto', !expanded && 'overflow-hidden')}
	>
		{#each model.sections as section (section.key)}
			{#if section.items.some((i) => !(mobile && i.href === NORBIUS))}
				<Stack gap="none" class="relative w-full p-2">
					<p
						class={cn(
							'flex h-8 shrink-0 items-center rounded-md px-2 text-overline transition-[margin,opacity] duration-200 ease-linear',
							!expanded && '-mt-8 opacity-0'
						)}
					>
						{section.label}
					</p>
					<!-- a phone's top bar carries Norbius; the drawer does not repeat it -->
					<Stack as="ul" gap="xs" class="w-full"
						>{#each section.items.filter((i) => !(mobile && i.href === NORBIUS)) as item (item.key)}{@render branch(item)}{/each}</Stack
					>
				</Stack>
			{/if}
		{/each}
	</div>

	<Stack
		gap="sm"
		class="shrink-0 border-t border-border bg-muted/30 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]"
	>
		{#if notice !== undefined}
			<a
				href={notice.href === undefined ? undefined : based(notice.href)}
				title={expanded ? undefined : notice.text}
				aria-label={expanded ? undefined : notice.text}
				data-shell-notice
				class={cn(
					'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs',
					notice.tone === 'warning' ? 'bg-warning/15' : 'bg-muted',
					!expanded && 'mx-auto size-8 justify-center p-0'
				)}
			>
				<Icon name="lucide:circle-alert" class="size-3.5 shrink-0" />
				{#if expanded}<span class="min-w-0 flex-1">{notice.text}</span
					>{#if notice.href !== undefined}<span class="shrink-0 font-medium underline"
							>{notice.action ?? t('Open')}</span
						>{/if}{/if}
			</a>
		{/if}
		{#if expanded}
			<Inline justify="between" align="center" gap="xs" class="h-8 px-1">
				<Inline gap="xs">
					<p class="text-overline">{t('Account')}</p>
					{#if environment !== null}
						<Badge
							variant={environment === 'staging' ? 'warning' : 'outline'}
							class="shrink-0 px-1.5 py-0 text-tiny leading-4 font-semibold"
							role="status"
							data-testid="environment-badge">{environment}</Badge
						>
					{/if}
					<span
						class={cn('size-1.5 shrink-0 rounded-full', SYNC[sync].dot)}
						title={t(SYNC[sync].label)}
						role="img"
						aria-label={t(SYNC[sync].label)}
						data-sync={sync}
					></span>
				</Inline>
				<Inline gap="none" align="center" class="-mr-1">
					{@render bell?.(true)}
					{@render more()}
				</Inline>
			</Inline>
		{:else}
			<Stack gap="xs" align="center">
				{#if environment !== null}
					<span
						class={cn(
							'size-2 rounded-full',
							environment === 'staging' ? 'bg-warning' : 'bg-muted-foreground/50'
						)}
						title={environment}
						role="img"
						aria-label={environment}
						data-testid="environment-badge"
					></span>
				{/if}
				{@render bell?.(false)}
				{@render more()}
			</Stack>
		{/if}
		{@render account()}
		{#if !expanded}<div class="mx-auto">{@render searchButton('')}</div>{/if}
	</Stack>
</nav>

{#snippet more()}
	{#if model.utilities.length > 0}
		<Popover.Root bind:open={moreOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<button
						{...props}
						type="button"
						aria-label={t('More')}
						data-active={model.utilities.some((u) => u.active) ? 'true' : undefined}
						class={cn(TOOL, 'grid place-items-center data-[active=true]:bg-sidebar-accent')}
					>
						<Icon name="lucide:ellipsis" class="size-3.5" />
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content
				side={expanded ? 'top' : 'right'}
				align={expanded ? 'end' : 'start'}
				side_offset={8}
				class="w-64 p-2"
			>
				<Stack gap="sm">
					{#each model.utilities as group (group.key)}
						<div>
							<p class="px-1.5 pb-1 text-overline">{group.label}</p>
							<Stack as="ul" gap="xs"
								>{#each group.children ?? [group] as item (item.key)}{@render branch(item, true)}{/each}</Stack
							>
						</div>
					{/each}
				</Stack>
			</Popover.Content>
		</Popover.Root>
	{/if}
{/snippet}

{#snippet account()}
	<Popover.Root
		bind:open={menuOpen}
		on_open_change={(o) => {
			if (o && load_teams !== undefined && teams === null) teams = load_teams();
		}}
	>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					type="button"
					aria-label={t('Open account menu')}
					data-testid="workspace-account"
					class={cn(
						'flex w-full min-w-0 items-center gap-2 overflow-visible rounded-md text-left text-xs outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent',
						expanded ? 'h-11 bg-popover px-2 py-1.5' : 'mx-auto size-8 justify-center p-0'
					)}
				>
					{@render avatar(
						model.user.name.slice(0, 1).toUpperCase(),
						model.user.email || model.user.name,
						null,
						expanded ? 'size-6' : 'size-8'
					)}
					{#if expanded}
						<span class="min-w-0 flex-1">
							<span class="block truncate text-xs font-medium">{model.user.name}</span>
							<span class="block truncate text-tiny text-muted-foreground">{model.user.email}</span>
						</span>
						<Icon name="lucide:chevron-up" class="ml-auto size-3.5 text-muted-foreground" />
					{/if}
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content
			side={expanded ? 'top' : 'right'}
			align={expanded ? 'center' : 'start'}
			side_offset={8}
			same_width={expanded}
			class={expanded ? 'p-1' : 'w-60 p-1'}
		>
			<div class="px-2 py-1.5">
				<p class="text-xs font-medium">{model.user.name}</p>
				{#if model.user.email}<p class="text-tiny text-muted-foreground">{model.user.email}</p>{/if}
				<p class="text-tiny text-muted-foreground">
					{t('Role: {role}').replace('{role}', model.user.role)}
				</p>
				{#if build !== null}<p
						class="text-tiny text-muted-foreground"
						data-build
						title={`Node ${build.node}`}
					>
						{build.workspace === null ? '' : `${t('Workspace')} ${build.workspace} · `}Bolt {build.bolt}
					</p>{/if}
			</div>
			<div class="-mx-1 my-1 h-px bg-border"></div>
			{#if on_locale !== undefined}
				<Button
					type="button"
					variant="ghost"
					class="h-9 w-full justify-start px-2 text-xs font-normal"
					aria-label={t('Switch language')}
					onclick={() => on_locale(nextLocale)}
				>
					<Icon name="lucide:languages" class="size-3.5" /><span>{t('Language')}</span><span
						class="ml-auto text-muted-foreground">{LANGUAGE[nextLocale]}</span
					>
				</Button>
			{/if}
			{#if on_theme !== undefined}
				<Inline gap="sm" class="h-9 w-full px-2 text-xs font-normal">
					<Icon name={THEME_ICON[theme]} class="size-3.5" /><span class="flex-1"
						>{t('Appearance')}</span
					>
					<Inline
						gap="none"
						role="radiogroup"
						aria-label={t('Appearance')}
						class="ml-auto shrink-0 rounded-md bg-muted p-0.5"
						data-testid="workspace-theme-toggle"
					>
						{#each THEMES as x (x)}
							<button
								type="button"
								role="radio"
								aria-checked={theme === x}
								aria-label={t(THEME_LABEL[x])}
								title={t(THEME_LABEL[x])}
								onclick={() => on_theme(x)}
								class={cn(
									'grid size-7 place-items-center rounded-sm text-muted-foreground hover:text-foreground',
									theme === x && 'bg-background text-foreground shadow-sm'
								)}
							>
								<Icon name={THEME_ICON[x]} class="size-3.5" />
							</button>
						{/each}
					</Inline>
				</Inline>
			{/if}
			{#if on_sounds !== undefined}
				<Button
					type="button"
					variant="ghost"
					class="h-9 w-full justify-start px-2 text-xs font-normal"
					aria-label={t('Sounds')}
					onclick={() => {
						menuOpen = false;
						on_sounds();
					}}
				>
					<Icon name={chimes ? 'lucide:volume-1' : 'lucide:volume-x'} class="size-3.5" />
					<span>{t('Sounds')}</span><span class="ml-auto text-muted-foreground"
						>{t(chimes ? 'On' : 'Off')}</span
					>
				</Button>
			{/if}
			{#if teams !== null || previewing}
				<div class="-mx-1 my-1 h-px bg-border"></div>
				<p class="px-2 pt-2 pb-1 text-overline">{t('Preview as a team')}</p>
				{#if teams !== null}
					{#await teams}
						<p class="px-2 pb-1"><Spinner class="size-3.5" /></p>
					{:then list}
						<div class="px-1 pb-1">
							<Combobox
								variant="ghost"
								class="w-full"
								value={null}
								placeholder={t('Choose a team')}
								aria-label={t('Preview as a team')}
								options={list.map((x) => ({ value: x.id, label: x.name }))}
								on_change={(id) => {
									if (id !== null) on_preview_team?.(id);
								}}
							/>
						</div>
					{/await}
				{/if}
				{#if previewing}
					<Button
						type="button"
						variant="ghost"
						class="h-9 w-full justify-start px-2 text-xs font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
						onclick={on_end_preview}
					>
						<Icon name="lucide:user-x" class="size-3.5" /><span>{t('End preview')}</span>
					</Button>
				{/if}
			{/if}
			<div class="-mx-1 my-1 h-px bg-border"></div>
			<Button
				type="button"
				variant="ghost"
				class="h-9 w-full justify-start px-2 text-xs font-normal hover:bg-destructive/10 hover:text-destructive"
				disabled={signingOut}
				onclick={sign_out}
			>
				<Icon name="lucide:log-out" class="size-3.5" /><span>{t('Sign out')}</span>
				{#if signingOut}<Spinner class="ml-auto size-3.5" />{/if}
			</Button>
		</Popover.Content>
	</Popover.Root>
{/snippet}
