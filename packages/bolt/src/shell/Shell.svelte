<!--
	The workspace shell (§5.10): boots the caller, routes the URL, and renders a page inside the sidebar shell, or
	a visitor page with no chrome, or the sign-in, invitation and registration pages. `$bolt` is created from the boot
	before any page chunk loads.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import { watch } from 'runed';
	import { PersistedState } from 'runed';
	import { MediaQuery } from 'svelte/reactivity';
	import { Bound, Center, Cover, INSET_X_CLASS, Inline, Stack, setAppIdentitySlot, type AppIdentitySlot } from '@norbital-ai/ui/layout';
	import { Button, Drawer, Icon, Sheet, Toaster, cn, openRecord, provideBolt, provideKinds, provideRepresentations, setUiText, type ViewBolt } from '@norbital-ai/ui';
	import { NorbiusStrip } from '@norbital-ai/ui/brand';
	import type { ShellMountConfig } from './mount.ts';
	import { based, isOpenRoute, logical, recordsOf, route, withRecords, type AppSpec, type ShellBoot } from './nav.ts';
	import { chosenLocale, frameworkText, setLocale, uiTextFor } from './i18n.ts';
	import type { SyncStatus } from '../client/bolt.ts';
	import { activeApp, media, navigationModel, NORBIUS } from './model.ts';
	import { applyTheme, storedTheme, storeTheme, type Theme } from './theme.ts';
	import { agentPanel, challengeQueue, setCurrentBolt, shellApi, shellBolt, type AgentRequest, type ShellBolt } from './runtime.ts';
	import Access from './Access.svelte';
	import SignIn from './SignIn.svelte';
	import Invite from './Invite.svelte';
	import Register from './Register.svelte';
	import AgentPanel from './Agent.svelte';
	import Inbox from './Inbox.svelte';
	import Settings from './Settings.svelte';
	import Studio from './Studio.svelte';
	import Conversations from './Conversations.svelte';
	import RecordSheet from './RecordSheet.svelte';
	import Turnstile from './Turnstile.svelte';
	import Nav from './Nav.svelte';
	import MediaHeader from './MediaHeader.svelte';
	import Finder from './Finder.svelte';
	import Home from './Home.svelte';
	import Bell from './Bell.svelte';

	let { config }: { config: ShellMountConfig } = $props();

	// svelte-ignore state_referenced_locally
	const api = shellApi(config.fetch);
	const agent = agentPanel();
	const challenge = challengeQueue();
	// the framework's own copy in the viewer's locale (their choice, else the workspace's); the workspace's messages win
	// svelte-ignore state_referenced_locally
	const locale = chosenLocale(config.manifest.workspace.locale);
	const framework = frameworkText(locale);
	const t = (key: string) => config.messages?.[key] ?? framework[key] ?? key;
	setUiText(uiTextFor(locale));
	// the appearance: the document applied the stored choice before paint; a change of choice or of the system's follows
	let theme = $state<Theme>(storedTheme());
	const systemDark = new MediaQuery('prefers-color-scheme: dark');
	watch([() => theme, () => systemDark.current], ([x, dark]) => applyTheme(x, dark));
	const dark = $derived(theme === 'dark' || (theme === 'system' && systemDark.current));
	const chooseTheme = (x: Theme) => {
		storeTheme(x);
		theme = x;
	};

	/** The page's URL as the workspace names it: without the base path the host serves it under. */
	const here = () => logical(location.href) ?? new URL(location.href);
	let url = $state(here());
	let boot = $state<ShellBoot | null>(null);
	// a signed-out caller's boot is refused, but names the workspace the access pages show
	let guest = $state<ShellBoot['workspace'] | null>(null);
	const workspace = $derived(boot?.workspace ?? guest);
	let bolt = $state<ShellBolt | null>(null);
	let failure = $state<string | null>(null);
	let agentRequest = $state<AgentRequest | null>(null);
	// Norbius is `?agent=<conversation>` (`new`: a new one) beside any `?record=` stack, as the record sheets are: opening
	// it pushes the param, closing removes it, a switch of conversation replaces it; a reload, back, forward or a shared
	// link reopens it on that conversation
	function agentUrl(value: string | null, replace = false): void {
		const next = here();
		if (value === null) next.searchParams.delete('agent');
		else next.searchParams.set('agent', value);
		if (next.href !== here().href) navigate(next.href, replace);
	}
	agent.subscribe((r) => {
		if (r === agentRequest) return; // the subscription's first call: the URL decides (below)
		agentRequest = r;
		const open = new URL(location.href).searchParams.get('agent');
		if (r === null && open !== null) agentUrl(null);
		else if (r !== null && open === null) agentUrl(r.conversation ?? 'new');
	});
	const agentParam = $derived(url.searchParams.get('agent'));
	watch(() => agentParam, (p) => {
		if (p === null) return void (agentRequest !== null && agent.close());
		const conversation = p === 'new' ? null : p;
		// a panel that has not reported its conversation yet keeps the one it chose
		if (agentRequest === null || (agentRequest.conversation !== undefined && agentRequest.conversation !== conversation)) agent.open({ ...agentRequest, conversation });
	});
	/** The panel switched conversation: the URL follows without a history entry. */
	function agentConversation(id: string | null): void {
		if (agentRequest !== null) agentRequest = { ...agentRequest, conversation: id };
		agentUrl(id ?? 'new', true);
	}
	// ui's generated forms and record views: the caller's exposure from the boot, pickers paging through `bolt.read`
	provideKinds({
		get catalog() { return boot?.catalog as never; },
		get locale() { return boot?.workspace.locale as string; },
		get zone() { return boot?.workspace.tz as string; },
		// a money field without its own currency reads in the workspace's (X-8)
		get currency() { return config.manifest.workspace.currency as string; },
		read: (collection, options) => bolt!.read(collection, options as never) as never,
		// a generated form's file field: bytes to `<collection>.<field>`, links to the stored file
		upload: (file, target) => bolt!.upload(file, target) as never,
		fileUrl: (ref) => bolt!.fileUrl(ref as never),
		get customFields() { return config.customFields as never; },
	});
	// the record views of every `RecordShell` under the shell, the `?record=` sheet's and a page's alike
	// a page's AppShell publishes its identity and actions here; the hero above the page renders them
	const identity = $state<AppIdentitySlot>({ current: null });
	setAppIdentitySlot(identity);
	// svelte-ignore state_referenced_locally
	provideRepresentations((config.representations ?? {}) as never);

	// ui's views on a page (`Table`, `Board`, …) read `$bolt` from context; pages render only after the boot sets it
	provideBolt(new Proxy({} as ViewBolt, { get: (_, k) => Reflect.get(bolt!, k), has: (_, k) => bolt !== null && k in bolt }));

	const current = $derived(route(config.manifest, url));
	// the record-sheet stack (rule 10): every `?record=`, the last on top
	const records = $derived(recordsOf(url));
	// a `kiosk: true` page renders alone, as staging's kiosk: no sidebar, banner, tabs, finder or agent; the way out is the URL bar
	const kiosk = $derived(current.kind === 'page' && (config.manifest.apps[current.app] as AppSpec | undefined)?.pages[current.page]?.kiosk === true);
	const publicApp = $derived(current.kind === 'page' && isOpenRoute(config.manifest, current) ? current.app : undefined);

	/** `href` is a workspace URL (`/inbox`); the history entry carries the base path. */
	function navigate(href: string, replace = false): void {
		const next = new URL(href, url);
		if (next.origin !== location.origin) return void (location.href = next.href);
		history[replace ? 'replaceState' : 'pushState'](null, '', `${based(next.pathname)}${next.search}${next.hash}`);
		url = next;
	}
	// a moved page (`/runs`, `/logs`) replaces its URL with its new home
	watch(() => current, (r) => { if (r.kind === 'redirect') navigate(r.to, true); });
	/** Settings → Automations' open run is `?run=<id>`, beside whatever the table keeps in the URL. */
	function openRun(id: string | null): void {
		const next = here();
		if (id === null) next.searchParams.delete('run');
		else next.searchParams.set('run', id);
		navigate(next.href);
	}
	// in-app links are plain anchors; the shell keeps them in the page
	function intercept(event: MouseEvent): void {
		const a = (event.target as Element | null)?.closest?.('a');
		if (a === null || a === undefined || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || a.target) return;
		const next = logical(a.href);
		if (next === null || next.pathname.startsWith('/__bolt/')) return;
		event.preventDefault();
		navigate(next.href);
	}

	async function load(app: string | undefined): Promise<void> {
		const r = await api.boot(app);
		if (!r.ok) {
			boot = null;
			guest = r.error.workspace ?? null;
			if (r.status === 401 && !isOpenRoute(config.manifest, current))
				navigate(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, true);
			else if (r.status !== 401) failure = r.error.message;
			return;
		}
		boot = r.value;
		bolt = shellBolt(r.value, { ...(config.messages === undefined ? {} : { messages: config.messages }), challenge, agent,
			...(config.fetch === undefined ? {} : { fetch: config.fetch }), ...(config.openStream === undefined ? {} : { openStream: config.openStream }) });
		setCurrentBolt(bolt);
		bolt.onSyncStatus((status) => (sync = status));
	}
	// the boot follows the audience: a public page boots its visitor, everything else the session
	watch(() => publicApp, (app) => void load(app));

	function pageOf(key: string): Promise<Component> | null {
		const chunk = config.pages[key];
		return chunk === undefined ? null : chunk().then((m) => m.default);
	}
	// keyed by a string: a query change (`?record=`) re-derives `current` but must not remount the page
	const pageKey = $derived(current.kind === 'page' && bolt !== null ? `${current.app}/${current.page}` : null);
	const page = $derived(pageKey === null ? null : pageOf(pageKey));

	async function signOut(): Promise<void> {
		await api.signOut();
		location.assign(based('/sign-in'));
	}
	async function endPreview(): Promise<void> {
		await api.preview(null);
		location.reload();
	}
	// ⌘K (Ctrl+K) opens Norbius, or closes it when open; ⌘/ (Ctrl+/) opens the finder; ⌘B (Ctrl+B) folds the sidebar
	let finding = $state(false);
	function shortcut(event: KeyboardEvent): void {
		if (!(event.metaKey || event.ctrlKey) || boot === null || boot.visitor !== null) return;
		if (event.key === '/') {
			event.preventDefault();
			finding = !finding;
			return;
		}
		if (event.key.toLowerCase() === 'b' && !narrow.current) {
			event.preventDefault();
			expanded.current = !expanded.current;
			return;
		}
		if (event.key.toLowerCase() !== 'k' || !boot.surfaces.agent) return;
		event.preventDefault();
		if (agentRequest === null) agent.open(); else agent.close();
	}
	// L-BOLT-499: the live link's state; `closed` means a new release closed it, and only a reload continues
	let sync = $state<SyncStatus>('idle');
	// the sidebar on wide screens; on narrow ones ui's Drawer, which closes once its user navigates (owner rule)
	const expanded = new PersistedState('workspace-shell.sidebar-expanded', true);
	// the phone's top bar: a drawer expands up to its lower edge (`--shell-header-height`)
	let headerHeight = $state(0);
	let navOpen = $state(false);
	/** What waits on the viewer, as the inbox last counted it (boot's count until then). */
	let waiting = $state<number | null>(null);
	const model = $derived(boot === null ? null : navigationModel(waiting === null ? boot : { ...boot, inbox: waiting }, url.pathname, t));
	const app = $derived(model === null ? null : activeApp(model));
	const mobileTitle = $derived(app?.label ?? model?.sections.flatMap((s) => s.items).find((i) => i.active)?.label ?? boot?.workspace.name ?? '');
	// an administrator's team preview from the account menu: the teams Settings lists
	async function teams(): Promise<{ id: string; name: string }[]> {
		const r = await api.settings();
		return r.ok ? r.value.teams.map((x) => ({ id: String(x['id']), name: String(x['name'] ?? x['id']) })) : [];
	}
	async function previewTeam(team: string): Promise<void> {
		await api.preview({ team });
		location.reload();
	}
	// the 48rem breakpoint base.css restates: below it the sidebar is a drawer
	const narrow = new MediaQuery('max-width: 47.999rem');
	const go = (href: string) => {
		if (href !== NORBIUS) return navigate(href);
		navOpen = false;
		agent.open();
	};
	// closing a sheet closes every sheet stacked on it
	const closeRecord = (depth: number) => navigate(withRecords(url, depth).href);
</script>

<svelte:window onpopstate={() => (url = here())} onkeydown={shortcut} />

{#snippet content()}
	{#if current.kind === 'home' && model !== null}
		<Home {model} {t} onNavigate={navigate} />
	{:else if current.kind === 'page'}
		{#if page === null}
			<Center><p>{t('Not found or no access')}</p></Center>
		{:else}
			{#await page}
				<Center><p>{t('Loading…')}</p></Center>
			{:then Page}
				<!-- the open app's banner (its AppShell's identity once published, the registry's until then) and its pages as tabs -->
				{#if !kiosk && (identity.current !== null || (app !== null && boot?.visitor === null))}
					<MediaHeader src={identity.current?.banner === undefined || identity.current.banner === null ? app?.thumbnail ?? null : media(identity.current.banner)} icon={identity.current?.icon ?? app?.icon ?? null}
						title={identity.current?.title ?? app?.label ?? null} description={identity.current?.description ?? app?.description ?? null}
						{...identity.current?.actions === undefined ? {} : { actions: identity.current.actions }} />
				{/if}
				{#if !kiosk && app?.pages !== undefined && boot?.visitor === null}
					<nav aria-label={t('Pages')} class={cn(INSET_X_CLASS, 'shrink-0 pt-3')}>
						<Inline gap="none" class="w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 [scrollbar-width:none]">
							{#each app.pages as p (p.key)}
								<a href={based(p.href)} aria-current={p.active ? 'page' : undefined}
									class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-sm">
									{#if p.icon}<Icon name={p.icon} class="size-3.5" />{/if}{p.label}
								</a>
							{/each}
						</Inline>
					</nav>
				{/if}
				<!-- hook:view-ui — a page sits inset from the sidebar; a page's own AppShell inset finds this owner and stays flush -->
				<Bound size="full" inset><Page /></Bound>
			{:catch cause}
				<!-- a page chunk that fails to load says which page and why (final-ui §7.2, L-BOLT-515) -->
				<Center><p role="alert">{t('The page {page} could not be loaded:').replace('{page}', pageKey ?? '')} {cause instanceof Error ? cause.message : String(cause)}</p></Center>
			{/await}
		{/if}
	{:else if current.kind === 'inbox' && boot?.surfaces.inbox && bolt}
		<Inbox {api} {bolt} {t} push={boot.push} onCount={(n) => (waiting = n)} />
	{:else if current.kind === 'settings' && boot?.surfaces.settings && bolt}
		<Settings {api} {bolt} {t} tab={current.tab} workspace={boot.workspace} run={url.searchParams.get('run')} onRun={openRun} />
	{:else if current.kind === 'redirect'}
		<Center><p>{t('Loading…')}</p></Center>
	{:else if current.kind === 'studio' && boot?.surfaces.studio}
		<Studio {api} {t} admin={boot.admin} tab={current.tab ?? 'workbench'} onTab={(x) => navigate(x === 'workbench' ? '/studio' : `/studio/${x}`)} />
	{:else if current.kind === 'conversations' && boot?.surfaces.conversations && bolt}
		<Conversations {api} {bolt} {t} id={current.id} />
	{:else}
		<Center><p>{t('Not found or no access')}</p></Center>
	{/if}
	{#if bolt !== null}
		{#each records as r, i (`${i}:${r.collection}/${r.id}`)}
			<RecordSheet collection={r.collection} id={r.id} onClose={() => closeRecord(i)} />
		{/each}
	{/if}
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<!-- hook:view-ui — the sidebar's width, the left bound of a maximised or widened right sheet (0 where no sidebar shows) -->
<div class="contents" onclick={intercept} style="--shell-sidebar-width: {boot !== null && boot.visitor === null && !kiosk && !narrow.current && failure === null ? (expanded.current ? '16rem' : '3rem') : '0px'}; --shell-header-height: {narrow.current && headerHeight > 0 ? `${headerHeight}px` : 'env(safe-area-inset-top)'}">
	{#if failure !== null}
		<Center><p role="alert">{failure}</p></Center>
	{:else if current.kind === 'signIn' || current.kind === 'invite' || current.kind === 'register'}
		<Access {t} environment={workspace?.environment} {locale} onLocale={setLocale} apex={workspace?.apex}
			dark={dark} onTheme={() => chooseTheme(dark ? 'light' : 'dark')}>
			{#if current.kind === 'signIn'}
				<SignIn {api} {t} next={current.next ?? '/'} workspace={workspace?.name} handle={workspace?.handle} />
			{:else if current.kind === 'invite'}
				<Invite {api} {t} id={current.id} signedIn={boot?.actor?.kind === 'member'} workspace={workspace?.name} />
			{:else if boot?.actor?.kind === 'member'}
				<Register {api} {t} claim={current.claim} />
			{:else}
				<SignIn {api} {t} next={url.pathname} workspace={workspace?.name} handle={workspace?.handle} />
			{/if}
		</Access>
	{:else if boot === null}
		<Center><p>{t('Loading…')}</p></Center>
	{:else if boot.visitor !== null}
		<!-- a visitor page: only its own app, no switcher, inbox, agent, settings or runs -->
		<Cover as="main" class="min-h-dvh">
			{@render content()}
			{#if boot.visitor.siteKey !== undefined}
				<Turnstile siteKey={boot.visitor.siteKey} queue={challenge} />
			{/if}
		</Cover>
	{:else if kiosk}
		<Toaster />
		<div class="h-dvh min-h-0 overflow-clip">{@render content()}</div>
	{:else}
		{#snippet navigation(open: boolean)}
			<Nav model={model!} expanded={open} mobile={narrow.current} {t} environment={boot?.workspace.environment ?? null} {locale} onLocale={setLocale}
				{theme} onTheme={chooseTheme} {sync} previewing={boot?.preview !== null} onEndPreview={endPreview}
				{...boot?.admin && boot.surfaces.settings && boot.preview === null ? { loadTeams: teams, onPreviewTeam: previewTeam } : {}}
				onSearch={() => { navOpen = false; finding = true; }} onNavigate={go} onSignOut={signOut}
				{...narrow.current ? {} : { onToggle: () => (expanded.current = !expanded.current) }}>
				{#snippet bell(wide)}{#if bolt !== null}<Bell {api} {bolt} {t} expanded={wide} onNavigate={(href) => { navOpen = false; navigate(href); }} />{/if}{/snippet}
			</Nav>
		{/snippet}
		<Toaster />
		<div class="flex h-dvh min-h-0 overflow-clip">
			{#if !narrow.current}
				<!-- staging's sidebar: 16rem, or a 3rem icon rail; the rail on its edge toggles it (⌘B) -->
				<aside class="group relative shrink-0 border-r transition-[width] duration-200 ease-linear" data-state={expanded.current ? 'expanded' : 'collapsed'}
					style="width: {expanded.current ? '16rem' : '3rem'}">
					{@render navigation(expanded.current)}
					<button type="button" tabindex={-1} aria-label={t('Toggle sidebar')} title={t('Toggle sidebar')} onclick={() => (expanded.current = !expanded.current)}
						class={cn('absolute inset-y-0 -right-2 z-20 w-4 after:absolute after:inset-y-0 after:left-[calc(50%-1px)] after:w-[2px] hover:after:bg-sidebar-border',
							expanded.current ? 'cursor-w-resize' : 'cursor-e-resize')}></button>
				</aside>
			{/if}
			<main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip bg-background">
				{#if narrow.current}
					<div class="shrink-0" bind:offsetHeight={headerHeight}>
					<Inline as="header" gap="sm" shrink={false} class="border-b bg-background px-[max(0.75rem,env(safe-area-inset-left))] pt-[calc(env(safe-area-inset-top)+0.25rem)] pb-1">
						<Button variant="ghost" size="icon" class="size-11" aria-label={t('Open navigation')} onclick={() => (navOpen = true)}>
							<Icon name="lucide:panel-bottom" class="size-4" />
						</Button>
						<p class="min-w-0 flex-1 truncate text-sm font-medium">{mobileTitle}</p>
						<Inline gap="xs" shrink={false} class="pr-[env(safe-area-inset-right)]">
							{#if bolt !== null}<Bell {api} {bolt} {t} expanded={false} onNavigate={navigate} />{/if}
							{#if boot.surfaces.agent}
								<Button variant="ghost" size="icon" class="size-11" aria-label={t('Norbius')} aria-haspopup="dialog" onclick={() => agent.open()}>
									<NorbiusStrip size={20} />
								</Button>
							{/if}
						</Inline>
					</Inline>
					</div>
				{/if}
				<Stack gap="none" fill class="min-h-0 pb-[env(safe-area-inset-bottom)] md:pb-0">
					{#if sync === 'closed'}
						<Inline role="alert" justify="between" class="bg-warning/15 px-4 py-2 text-xs">
							<span>{t('This workspace was updated. Reload to continue with the new version.')}</span>
							<Button size="sm" variant="outline" onclick={() => location.reload()}>{t('Reload')}</Button>
						</Inline>
					{/if}
					{#if boot.notice !== undefined}
						<Inline role="status" justify="between" class={['px-4 py-2 text-xs', boot.notice.tone === 'warning' ? 'bg-warning/15' : 'bg-muted']}>
							<span>{boot.notice.text}</span>
							{#if boot.notice.href !== undefined}<Button size="sm" variant="outline" href={based(boot.notice.href)}>{boot.notice.action ?? t('Open')}</Button>{/if}
						</Inline>
					{/if}
					{#if boot.preview !== null}
						<Inline role="status" justify="between" class="bg-warning/15 px-4 py-2 text-xs">
							<span>{'team' in boot.preview ? t('Previewing as a team. Its grants apply; you are recorded as the previewer.')
								: t('Previewing as another member. Their grants apply; you are recorded as the previewer.')}</span>
							<Button size="sm" variant="outline" onclick={endPreview}>{t('End preview')}</Button>
						</Inline>
					{/if}
					{@render content()}
				</Stack>
			</main>
			{#if narrow.current}
				<Drawer bind:open={navOpen} path={url.pathname + url.search} title={boot.workspace.name}>{@render navigation(true)}</Drawer>
			{/if}
		</div>
		{#if bolt !== null}
			<Finder bind:open={finding} nav={boot.nav} catalog={boot.catalog} read={(c, o) => bolt!.read(c, o)} {t} onNavigate={navigate}
				onOpenRecord={(c, id) => openRecord(c, id)} onAsk={boot.surfaces.agent ? (prompt) => agent.open({ prompt }) : null} />
		{/if}
		{#if boot.surfaces.agent && bolt !== null}
			<!-- non-modal, as every side sheet: the page stays usable; only Esc or × closes it -->
			<Sheet open={agentRequest !== null} title={t('Norbius')} onOpenChange={(open) => { if (!open) agent.close(); }}>
					{#if agentRequest !== null && config.agent !== undefined}
						{@const Agent = config.agent}
						<Agent {bolt} request={agentRequest} onClose={() => agent.close()} />
					{:else if agentRequest !== null}
						<AgentPanel {api} {bolt} {t} request={agentRequest} unconfigured={boot.aiUnconfigured === true} onClose={() => agent.close()} onConversation={agentConversation} />
					{/if}
			</Sheet>
		{/if}
	{/if}
</div>
