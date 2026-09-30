<!--
	The workspace sidebar, as staging draws it: the workspace switcher with the finder and the collapse toggle; the model's
	sections as icon-tile rows (Norbius wears its strip); and the account footer — its label, the environment badge, the
	sync dot, the bell and the Settings/System/Kiosks menu, then the account card whose menu holds language, appearance, team
	preview and sign-out. Collapsed (`expanded` false) it is a 3rem icon rail with tooltips.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { watch } from 'runed';
	import { Badge, Button, Combobox, Icon, Popover, Spinner, Tooltip, cn } from '@norbital-ai/ui';
	import { FEATURE_COLORS, NorbiusStrip } from '@norbital-ai/ui/brand';
	import { Frame, Imposter, Inline, Stack } from '@norbital-ai/ui/layout';
	import type { SyncStatus } from '../client/bolt.ts';
	import { NORBIUS, type NavItem, type NavModel, type Translate } from './model.ts';
	import { based, type ShellNotice } from './nav.ts';
	import { LANGUAGE, LOCALES } from './i18n.ts';
	import { THEMES, type Theme } from './theme.ts';

	let {
		model, expanded = true, mobile = false, t, environment = null, locale = 'en', onLocale, theme = 'system', onTheme, sync = 'idle',
		previewing = false, loadTeams, onPreviewTeam, onEndPreview, onSearch, onToggle, onNavigate, onSignOut, bell, notice,
	}: {
		model: NavModel; expanded?: boolean; mobile?: boolean; t: Translate; environment?: string | null; locale?: string;
		onLocale?: (locale: string) => void; theme?: Theme; onTheme?: (theme: Theme) => void; sync?: SyncStatus;
		/** A preview runs: the menu offers its end. `loadTeams` is an administrator's: the teams a preview may take. */
		previewing?: boolean; loadTeams?: () => Promise<readonly { id: string; name: string }[]>; onPreviewTeam?: (team: string) => void; onEndPreview?: () => void;
		onSearch?: () => void; onToggle?: () => void; onNavigate: (href: string) => void; onSignOut: () => void | Promise<void>;
		/** The notification bell (it reads the live inbox the shell owns). */
		bell?: Snippet<[boolean]>;
		/** The host's notice (a billing reminder): a footer line here, so it never takes the page's height. */
		notice?: ShellNotice | undefined;
	} = $props();

	const base = $derived(LOCALES.find((l) => locale.startsWith(l)) ?? 'en');
	const nextLocale = $derived(LOCALES[(LOCALES.indexOf(base) + 1) % LOCALES.length]!);
	// the versions `bolt build` bakes into the client (L-BOLT-073); absent when the shell is mounted unbuilt (tests)
	const build = typeof __BOLT_BUILD__ === 'undefined' ? null : __BOLT_BUILD__;
	const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
	const withKey = (label: string, key: string) => `${label} · ${mod}${key}`;
	const THEME_ICON: { readonly [x in Theme]: string } = { light: 'lucide:sun', dark: 'lucide:moon', system: 'lucide:monitor' };
	const THEME_LABEL: { readonly [x in Theme]: string } = { light: 'Light', dark: 'Dark', system: 'System' };
	// `idle` is the stream nobody asked for (no live read is open), not a failure; `connecting` is opening or retrying a drop
	const SYNC: { readonly [s in SyncStatus]: { dot: string; label: string } } = {
		live: { dot: 'bg-success', label: 'Connected' }, connecting: { dot: 'animate-pulse bg-muted-foreground/60', label: 'Reconnecting' },
		idle: { dot: 'bg-muted-foreground/40', label: 'Idle' }, closed: { dot: 'bg-destructive', label: 'Connection closed' },
	};

	const follow = (event: MouseEvent, href: string) => {
		event.preventDefault();
		onNavigate(href);
	};
	/** Staging's avatar fallback: a hue hashed from the identifier. */
	const hue = (s: string) => `hsl(${Math.abs([...s].reduce((h, c) => c.charCodeAt(0) + ((h << 5) - h), 0)) % 360} 65% 55%)`;
	const initials = (name: string) => {
		const words = name.trim().split(/\s+/).filter(Boolean);
		return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)).toUpperCase() || '?';
	};

	// a row with children is a disclosure, open while it holds the active page (staging's branch)
	let open = $state<{ [key: string]: boolean }>({});
	watch(() => model.sections.flatMap((s) => s.items).filter((i) => i.active && i.children).map((i) => i.key), (keys) => {
		for (const k of keys) open[k] = true;
	});

	let menuOpen = $state(false), moreOpen = $state(false), switcherOpen = $state(false);
	let teams = $state<Promise<readonly { id: string; name: string }[]> | null>(null);
	let signingOut = $state(false);
	async function signOut(): Promise<void> {
		signingOut = true;
		try { await onSignOut(); } finally { signingOut = false; }
	}
	const ROW = 'relative flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-md text-left outline-hidden ring-sidebar-ring transition-[width,height,padding] focus-visible:ring-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground';
	const SUB = 'flex h-7 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md py-0 pr-2 pl-1.5 text-xs text-sidebar-foreground outline-hidden ring-sidebar-ring focus-visible:ring-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground';
	const LABEL = 'min-w-0 flex-1 truncate text-xs font-normal sm:text-micro';
	const TOOL = 'size-7 rounded-md p-0 hover:bg-accent data-[state=open]:bg-accent';
</script>

{#snippet avatar(name: string, identifier: string, logo: string | null, size: string)}
	<Frame ratio="square" shrink={false} class={cn('rounded-full text-tiny font-medium', size)}>
		{#if logo}<img src={logo} alt="" class="size-full rounded-md object-cover" />
		{:else}<Inline as="span" justify="center" class="size-full rounded-full" style="background-color: {hue(identifier)}">{name}</Inline>{/if}
	</Frame>
{/snippet}

{#snippet tile(item: NavItem)}
	{@const color = item.featureColor === undefined ? null : FEATURE_COLORS[item.featureColor]}
	<Frame ratio="square" shrink={false} class={cn('size-6 rounded-md border shadow-xs', color?.iconWrapperClass ?? 'border-input bg-background text-foreground')}>
		{#if item.href === NORBIUS}<NorbiusStrip size={20} />
		{:else}<Icon name={item.icon ?? 'lucide:layout-grid'} class={cn('size-3.5', color?.iconClass)} />{/if}
	</Frame>
{/snippet}

{#snippet tip(text: string, side: 'right' | 'bottom' | 'top', disabled: boolean, trigger: Snippet<[{ props: Record<string, unknown> }]>)}
	<Tooltip {side} {text} {disabled} {trigger} />
{/snippet}

{#snippet row(item: NavItem)}
	<li class="relative">
		{#snippet link({ props }: { props: Record<string, unknown> })}
			{@const disclosure = expanded && item.children !== undefined}
			<svelte:element this={disclosure ? 'button' : 'a'} {...props} type={disclosure ? 'button' : undefined} href={disclosure ? undefined : based(item.href)}
				aria-current={!disclosure && item.active ? 'page' : undefined} aria-expanded={disclosure ? open[item.key] === true : undefined}
				aria-haspopup={item.href === NORBIUS ? 'dialog' : undefined} data-active={item.active ? 'true' : undefined} data-testid={item.href === NORBIUS ? 'workspace-agent-trigger' : undefined}
				class={cn(ROW, expanded ? 'h-7 p-2 pr-7' : 'size-8 justify-center p-1')}
				onclick={(e: MouseEvent) => (disclosure ? (open[item.key] = !open[item.key]) : follow(e, item.href))}>
				{#if item.active}<span class="absolute top-1/4 left-0.5 h-1/2 w-[3px] rounded-lg bg-brand" aria-hidden="true"></span>{/if}
				{@render tile(item)}
				{#if expanded}
					<span class={LABEL}>{item.label}</span>
					{#if item.href === NORBIUS}
						<kbd class="pointer-events-none absolute top-1/2 right-2 hidden h-5 -translate-y-1/2 rounded-md border border-border bg-muted px-1.5 py-px font-mono text-tiny leading-4 font-medium text-muted-foreground select-none sm:inline-block" aria-hidden="true">{mod}K</kbd>
					{:else if item.children !== undefined}
						<Icon name="lucide:chevron-right" class={cn('pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 transition-transform duration-150', open[item.key] && 'rotate-90')} />
					{:else if item.badge}
						<Badge variant="outline" class="absolute top-1/2 right-1.5 -translate-y-1/2 px-1.5 py-0 text-tiny leading-4 font-medium" aria-hidden="true">{item.badge}</Badge>
					{/if}
				{/if}
			</svelte:element>
		{/snippet}
		{@render tip(item.href === NORBIUS ? withKey(item.label, 'K') : item.label, 'right', expanded || mobile, link)}
		{#if expanded && item.children !== undefined && open[item.key]}
			<Stack as="ul" gap="xs" class="mr-0 ml-5 border-l border-sidebar-border py-0.5 pr-0 pl-2">
				{#each item.children as child (child.key)}{@render sub(child)}{/each}
			</Stack>
		{/if}
	</li>
{/snippet}

{#snippet sub(item: NavItem)}
	<li>
		<a href={based(item.href)} aria-current={item.active ? 'page' : undefined} data-active={item.active ? 'true' : undefined} class={SUB}
			onclick={(e) => { moreOpen = false; follow(e, item.href); }}>
			<Frame as="span" ratio="square" shrink={false} class="size-6"><Icon name={item.icon ?? 'lucide:file'} class="size-3.5" /></Frame>
			<span class={LABEL}>{item.label}</span>
			{#if item.badge}<Badge variant="outline" class="px-1.5 py-0 text-tiny leading-4 font-medium">{item.badge}</Badge>{/if}
		</a>
	</li>
{/snippet}

{#snippet searchButton(extra: string)}
	{#if onSearch !== undefined}
		{#snippet trigger({ props }: { props: Record<string, unknown> })}
			<Button {...props} type="button" variant="ghost" size="icon" class={cn('size-8 shrink-0', extra)} aria-label={`${t('Find')} (${mod}/)`} onclick={onSearch} data-testid="workspace-omni-trigger">
				<Icon name="lucide:search" class="size-4" />
			</Button>
		{/snippet}
		{@render tip(withKey(t('Find'), '/'), expanded ? 'bottom' : 'right', mobile, trigger)}
	{/if}
{/snippet}

{#snippet toggle(extra: string, tabindex: number | undefined)}
	{#if onToggle !== undefined}
		{#snippet trigger({ props }: { props: Record<string, unknown> })}
			<Button {...props} type="button" variant="ghost" size="icon" {tabindex} class={cn('size-8 shrink-0', extra)} data-sidebar="trigger"
				aria-label={t(expanded ? 'Collapse sidebar' : 'Expand sidebar')} onclick={onToggle}>
				<Icon name="lucide:panel-left" class="size-4" />
			</Button>
		{/snippet}
		{@render tip(withKey(t(expanded ? 'Collapse sidebar' : 'Expand sidebar'), 'B'), 'bottom', !expanded, trigger)}
	{/if}
{/snippet}

{#snippet switcher()}
	<Popover.Root bind:open={switcherOpen}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button {...props} type="button" aria-label={t('Switch workspace')} data-testid="workspace-switcher"
					class={cn('flex min-w-0 items-center gap-2 rounded-md border border-input bg-background text-sm shadow-xs outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
						expanded ? 'h-8 w-full px-2' : 'size-8 justify-center p-0')}>
					{@render avatar(initials(model.workspace.name), model.workspace.name, model.workspace.logo, 'size-6')}
					{#if expanded}<span class="min-w-0 flex-1 truncate text-left text-xs font-medium">{model.workspace.name}</span>{/if}
				</button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="start" side={expanded ? 'bottom' : 'right'} sideOffset={6} class="w-64 p-1">
			<Inline gap="sm" class="rounded-sm bg-accent/60 px-2 py-1.5">
				{@render avatar(initials(model.workspace.name), model.workspace.name, model.workspace.logo, 'size-6')}
				<span class="min-w-0 flex-1 truncate text-xs font-medium">{model.workspace.name}</span>
				<Icon name="lucide:check" class="size-3.5 shrink-0" />
			</Inline>
			<!-- a full load: the link leaves this workspace through the host's handoff -->
			{#each model.workspace.others as w (w.handle)}
				<a href={w.href} data-sveltekit-reload data-testid="workspace-option" class="mt-1 flex h-8 items-center gap-2 rounded-sm px-2 text-xs hover:bg-accent">
					{@render avatar(initials(w.name), w.handle, null, 'size-6')}
					<span class="min-w-0 flex-1 truncate">{w.name}</span>
				</a>
			{/each}
		</Popover.Content>
	</Popover.Root>
{/snippet}

<nav aria-label={t('Workspace navigation')} class="flex h-full min-h-0 w-full flex-col overflow-x-hidden bg-sidebar text-xs text-sidebar-foreground">
	<div class="shrink-0 p-2">
		{#if expanded}
			<Inline gap="xs" class="h-8">
				<div class="min-w-0 flex-1">{@render switcher()}</div>
				{@render searchButton('')}
				{@render toggle('', undefined)}
			</Inline>
		{:else}
			<!-- collapsed: the workspace mark, swapped for the expand toggle on hover (staging's rail header) -->
			<div class="group/org relative mx-auto size-8">
				<div class="size-8 transition-opacity group-hover/org:pointer-events-none group-hover/org:opacity-0">{@render switcher()}</div>
				<Imposter placement="fill" class="pointer-events-none opacity-0 group-hover/org:pointer-events-auto group-hover/org:opacity-100">
					{@render toggle('', -1)}
				</Imposter>
			</div>
		{/if}
	</div>

	<div class={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto', !expanded && 'overflow-hidden')}>
		{#each model.sections as section (section.key)}
			{#if section.items.length > 0}
				<Stack gap="none" class="relative w-full p-2">
					<p class={cn('flex h-8 shrink-0 items-center rounded-md px-2 text-overline transition-[margin,opacity] duration-200 ease-linear', !expanded && '-mt-8 opacity-0')}>{section.label}</p>
					<Stack as="ul" gap="xs" class="w-full">{#each section.items as item (item.key)}{@render row(item)}{/each}</Stack>
				</Stack>
			{/if}
		{/each}
	</div>

	<Stack gap="sm" class="shrink-0 border-t border-border bg-muted/30 px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
		{#if notice !== undefined}
			<a href={notice.href === undefined ? undefined : based(notice.href)} title={expanded ? undefined : notice.text} aria-label={expanded ? undefined : notice.text} data-shell-notice
				class={cn('flex items-center gap-2 rounded-md px-2 py-1.5 text-xs', notice.tone === 'warning' ? 'bg-warning/15' : 'bg-muted', !expanded && 'mx-auto size-8 justify-center p-0')}>
				<Icon name="lucide:circle-alert" class="size-3.5 shrink-0" />
				{#if expanded}<span class="min-w-0 flex-1">{notice.text}</span>{#if notice.href !== undefined}<span class="shrink-0 font-medium underline">{notice.action ?? t('Open')}</span>{/if}{/if}
			</a>
		{/if}
		{#if expanded}
			<Inline justify="between" align="center" gap="xs" class="h-7 px-1">
				<Inline gap="xs">
					<p class="text-overline">{t('Account')}</p>
					{#if environment !== null}
						<Badge variant={environment === 'staging' ? 'warning' : 'outline'} class="shrink-0 px-1.5 py-0 text-tiny leading-4 font-semibold" role="status" data-testid="environment-badge">{environment}</Badge>
					{/if}
					<span class={cn('size-1.5 shrink-0 rounded-full', SYNC[sync].dot)} title={t(SYNC[sync].label)} role="img" aria-label={t(SYNC[sync].label)} data-sync={sync}></span>
				</Inline>
				<Inline gap="none" align="center" class="-mr-1">
					{@render bell?.(true)}
					{@render more()}
				</Inline>
			</Inline>
		{:else}
			<Stack gap="xs" align="center">
				{#if environment !== null}
					<span class={cn('size-2 rounded-full', environment === 'staging' ? 'bg-warning' : 'bg-muted-foreground/50')} title={environment} role="img" aria-label={environment} data-testid="environment-badge"></span>
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
					<button {...props} type="button" aria-label={t('More')} data-active={model.utilities.some((u) => u.active) ? 'true' : undefined}
						class={cn(TOOL, 'grid place-items-center data-[active=true]:bg-sidebar-accent', !expanded && 'size-8')}>
						<Icon name="lucide:ellipsis" class="size-3.5" />
					</button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content side={expanded ? 'top' : 'right'} align={expanded ? 'end' : 'start'} sideOffset={8} class="w-64 p-2">
				<Stack gap="sm">
					{#each model.utilities as group (group.key)}
						<div>
							<p class="px-1.5 pb-1 text-overline">{group.label}</p>
							<Stack as="ul" gap="xs">{#each group.children ?? [group] as item (item.key)}{@render sub(item)}{/each}</Stack>
						</div>
					{/each}
				</Stack>
			</Popover.Content>
		</Popover.Root>
	{/if}
{/snippet}

{#snippet account()}
	<Popover.Root bind:open={menuOpen} onOpenChange={(o) => { if (o && loadTeams !== undefined && teams === null) teams = loadTeams(); }}>
		<Popover.Trigger>
			{#snippet child({ props })}
				<button {...props} type="button" aria-label={t('Open account menu')} data-testid="workspace-account"
					class={cn('flex w-full min-w-0 items-center gap-2 overflow-visible rounded-md text-left text-xs outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent',
						expanded ? 'h-11 bg-popover px-2 py-1.5' : 'mx-auto size-8 justify-center p-0')}>
					{@render avatar(model.user.name.slice(0, 1).toUpperCase(), model.user.email || model.user.name, null, expanded ? 'size-6' : 'size-8')}
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
		<Popover.Content side={expanded ? 'top' : 'right'} align={expanded ? 'center' : 'start'} sideOffset={8} class="w-72 max-w-[calc(100vw-1rem)] p-1">
			<div class="px-2 py-1.5">
				<p class="text-xs font-medium">{model.user.name}</p>
				{#if model.user.email}<p class="text-tiny text-muted-foreground">{model.user.email}</p>{/if}
				<p class="text-tiny text-muted-foreground">{t('Role: {role}').replace('{role}', model.user.role)}</p>
				{#if build !== null}<p class="text-tiny text-muted-foreground" data-build title={`Node ${build.node}`}>{build.workspace === null ? '' : `${t('Workspace')} ${build.workspace} · `}Bolt {build.bolt}</p>{/if}
			</div>
			<div class="-mx-1 my-1 h-px bg-border"></div>
			{#if onLocale !== undefined}
				<Button type="button" variant="ghost" class="h-9 w-full justify-start px-2 text-xs font-normal" aria-label={t('Switch language')} onclick={() => onLocale(nextLocale)}>
					<Icon name="lucide:languages" class="size-3.5" /><span>{t('Language')}</span><span class="ml-auto text-muted-foreground">{LANGUAGE[nextLocale]}</span>
				</Button>
			{/if}
			{#if onTheme !== undefined}
				<Inline gap="sm" class="h-9 px-2">
					<Icon name={THEME_ICON[theme]} class="size-3.5" /><span class="flex-1">{t('Appearance')}</span>
					<Inline gap="none" role="radiogroup" aria-label={t('Appearance')} class="rounded-md bg-muted p-0.5" data-testid="workspace-theme-toggle">
						{#each THEMES as x (x)}
							<button type="button" role="radio" aria-checked={theme === x} aria-label={t(THEME_LABEL[x])} title={t(THEME_LABEL[x])} onclick={() => onTheme(x)}
								class={cn('grid size-6 place-items-center rounded-sm text-muted-foreground hover:text-foreground', theme === x && 'bg-background text-foreground shadow-sm')}>
								<Icon name={THEME_ICON[x]} class="size-3.5" />
							</button>
						{/each}
					</Inline>
				</Inline>
			{/if}
			{#if teams !== null || previewing}
				<div class="-mx-1 my-1 h-px bg-border"></div>
				<p class="px-2 pt-2 pb-1 text-overline">{t('Preview as a team')}</p>
				{#if teams !== null}
					{#await teams}
						<p class="px-2 pb-1"><Spinner class="size-3.5" /></p>
					{:then list}
						<div class="px-1 pb-1">
							<Combobox variant="ghost" class="w-full" value={null} placeholder={t('Choose a team')} aria-label={t('Preview as a team')}
								options={list.map((x) => ({ value: x.id, label: x.name }))} onChange={(id) => { if (id !== null) onPreviewTeam?.(id); }} />
						</div>
					{/await}
				{/if}
				{#if previewing}
					<Button type="button" variant="ghost" class="h-9 w-full justify-start px-2 text-xs font-normal text-destructive hover:bg-destructive/10 hover:text-destructive" onclick={onEndPreview}>
						<Icon name="lucide:user-x" class="size-3.5" /><span>{t('End preview')}</span>
					</Button>
				{/if}
			{/if}
			<div class="-mx-1 my-1 h-px bg-border"></div>
			<Button type="button" variant="ghost" class="h-9 w-full justify-start px-2 text-xs font-normal hover:bg-destructive/10 hover:text-destructive" disabled={signingOut} onclick={signOut}>
				<Icon name="lucide:log-out" class="size-3.5" /><span>{t('Sign out')}</span>
				{#if signingOut}<Spinner class="ml-auto size-3.5" />{/if}
			</Button>
		</Popover.Content>
	</Popover.Root>
{/snippet}
