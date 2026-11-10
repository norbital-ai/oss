<!--
	The workspace shell (§5.10): boots the caller, routes the URL, and renders a page inside the sidebar shell, or
	a visitor page with no chrome, or the sign-in and invitation pages. The shell creates the page context from the boot
	before any page chunk loads.
-->
<script lang="ts">
	import { attach, fork, run } from '@norbital-ai/ui/effect';
	import { Effect, Exit, FiberHandle, Option, Scope, Stream, SubscriptionRef } from 'effect';
	import { updating } from '../protocol/client.ts';
	import { setContext, tick, type Component } from 'svelte';
	import { watch } from 'runed';
	import { PersistedState } from 'runed';
	import { MediaQuery, SvelteMap } from 'svelte/reactivity';
	import {
		AppHeader,
		Bound,
		Center,
		Cover,
		INSET_X_CLASS,
		Inline,
		Stack,
		setAppIdentitySlot,
		type AppIdentitySlot
	} from '@norbital-ai/ui/layout';
	import {
		Button,
		Drawer,
		Icon,
		Sheet,
		Spinner,
		TAB_LEVEL,
		TabStrip,
		TableSkeleton,
		Toaster,
		cn,
		confirmAction,
		openRecord,
		provideBolt,
		provideKinds,
		provideRepresentations,
		setUiText
	} from '@norbital-ai/ui';
	import { NorbiusStrip } from '@norbital-ai/ui/brand';
	import type { ShellMountConfig } from './mount.ts';
	import {
		based,
		commandCenterTabs,
		isOpenRoute,
		logical,
		navApps,
		navigationPaths,
		previewRoute,
		recordsOf,
		route,
		withRecords,
		type ShellBoot
	} from './nav.ts';
	import { chosenLocale, frameworkText, setLocale, uiTextFor } from './i18n.ts';
	import type { SyncStatus } from '../page/bolt.ts';
	import type { FinderAnswer } from './finder/model.ts';
	import { activeApp, media, navigationModel, NORBIUS } from './model.ts';
	import { applyTheme, storedTheme, storeTheme, type Theme } from './theme.ts';
	import {
		agentPanel,
		challengeQueue,
		shellApi,
		shellBolt,
		type AgentRequest,
		type ShellBolt
	} from './runtime.ts';
	import Access from './auth/Access.svelte';
	import SignIn from './auth/SignIn.svelte';
	import Invite from './auth/Invite.svelte';
	import Attention from './agent/Attention.svelte';
	import Awaiting from './agent/Awaiting.svelte';
	import Waiting from './inbox/Waiting.svelte';
	import { awaitingAfter, type Awaiting as AwaitingKind } from './agent/chime.ts';
	import { createSounds, SOUNDS, type SoundKind, type SoundStatus } from './sounds.ts';
	import SoundSettings from './settings/Sounds.svelte';
	import { CLIENT_NAVIGATION, type ClientNavigation } from './agent/navigation.ts';
	import { CLIENT_PAGE_ACTION, type ClientPageAction } from './agent/navigation.ts';
	import {
		fillField,
		pageClickable,
		pageField,
		pageFieldLabel,
		pageCovered,
		pageLabel,
		pageMark,
		pageScreen,
		ringOn
	} from './agent/page.ts';
	import Inbox from './inbox/Inbox.svelte';
	import { clientNavigationPath, systemUiIntent } from '../protocol/system-ui.ts';
	import type { PageResult } from '../protocol/schema.ts';
	import StudioSlot from './studio/StudioSlot.svelte';
	import RecordSheet from './RecordSheet.svelte';
	import Turnstile from './auth/Turnstile.svelte';
	import Nav from './Nav.svelte';
	import Finder from './finder/Finder.svelte';
	import Home from './Home.svelte';
	import Bell from './Bell.svelte';
	import DeviceWall from './DeviceWall.svelte';
	import { deviceAccess } from './device-access.ts';
	import { resolveDevice } from '../page/device.ts';
	import { deviceSession, openExternal } from './device-session.ts';
	import { commandKey } from './keyboard.ts';

	let { config }: { config: ShellMountConfig } = $props();

	// svelte-ignore state_referenced_locally
	const api = shellApi(config.fetch);
	const agent = agentPanel();
	// Studio's Take control: the person hands the preview back by steering this conversation, as themselves
	$effect(() => {
		const onMessage = (event: MessageEvent) => {
			if (event.origin !== location.origin) return;
			const data = event.data as { type?: unknown; id?: unknown } | null;
			if (data?.type !== 'norbital:preview-release') return;
			let conversation: string | null = null;
			try {
				if (agentMemory !== undefined) conversation = localStorage.getItem(agentMemory);
			} catch {
				conversation = null;
			}
			if (conversation === null) return;
			fork(
				api.agent
					.post(
						conversation,
						`I took control of the Studio preview${typeof data.id === 'string' ? ` !${data.id}` : ''}. You no longer control it; open the preview with browser to take it back when I ask.`,
						true
					)
					.pipe(
						Effect.asVoid,
						Effect.catch((error) => Effect.logWarning(error))
					)
			);
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	});

	let challenge = $state<import('./runtime.ts').ChallengeQueue | null>(null);
	// the framework's own copy in the viewer's locale (their choice, else the workspace's); the workspace's messages win
	// svelte-ignore state_referenced_locally
	const locale = chosenLocale(config.manifest.workspace.locale);
	const framework = frameworkText(locale);
	const t = (key: string) => config.messages?.[key] ?? framework[key] ?? key;
	const uiText = uiTextFor(locale);
	setUiText(uiText);
	// the appearance: the document applied the stored choice before paint; a change of choice or of the system's follows
	let theme = $state<Theme>('system');
	fork(
		storedTheme.pipe(
			Effect.tap((stored) =>
				Effect.sync(() => {
					theme = stored;
				})
			)
		)
	);
	const systemDark = new MediaQuery('prefers-color-scheme: dark');
	watch([() => theme, () => systemDark.current], ([x, dark]) => applyTheme(x, dark));
	const dark = $derived(theme === 'dark' || (theme === 'system' && systemDark.current));
	const chooseTheme = (x: Theme) => {
		fork(storeTheme(x));
		theme = x;
	};

	/** The page's URL as the workspace names it: without the base path the host serves it under. */
	const here = () => logical(location.href) ?? new URL(location.href);
	let url = $state(here());
	let boot = $state<ShellBoot | null>(null);
	/** A later boot's answer for the host's sidebar notice, read again as a notice arrives (a maintenance scheduled). */
	let refreshed = $state<Pick<ShellBoot, 'notice'> | null>(null);
	const configuration = $derived(boot?.admin === true ? systemUiIntent(url) : null);
	// a signed-out caller's boot is refused, but names the workspace the access pages show
	let guest = $state<ShellBoot['workspace'] | null>(null);
	const workspace = $derived(boot?.workspace ?? guest);
	/** Norbius's last opened conversation, kept per workspace and member so a shared browser never crosses accounts. */
	const agentMemory = $derived(
		boot?.actor?.kind === 'member'
			? `bolt.agent.conversation:${boot.workspace.handle ?? boot.workspace.name}:${boot.actor.id}`
			: undefined
	);
	let chimes = $state(true);
	let soundsOpen = $state(false);
	let soundStatus = $state<SoundStatus>(
		typeof AudioContext === 'undefined' ? 'unavailable' : 'needs-gesture'
	);
	const chimeKey = $derived(boot?.actor?.kind === 'member' ? `bolt.sounds:${boot.actor.id}` : null);
	watch(
		() => chimeKey,
		(key) => {
			try {
				chimes =
					key !== null &&
					(localStorage.getItem(key) ??
						localStorage.getItem(key.replace('bolt.sounds:', 'bolt.norbius.sounds:'))) !== 'off';
			} catch {
				chimes = true;
			}
		}
	);
	const sounds = createSounds(
		() => chimes,
		(status) => {
			soundStatus = status;
		}
	);
	setContext(SOUNDS, sounds);
	const chooseChimes = (enabled: boolean) => {
		chimes = enabled;
		try {
			if (chimeKey !== null) localStorage.setItem(chimeKey, enabled ? 'on' : 'off');
		} catch {
			/* Device storage may be disabled. */
		}
		if (enabled) void sounds.test();
	};
	$effect(() => {
		const unlock = () => {
			void sounds.unlock();
		};
		window.addEventListener('click', unlock, true);
		window.addEventListener('keydown', unlock, true);
		return () => {
			window.removeEventListener('click', unlock, true);
			window.removeEventListener('keydown', unlock, true);
			sounds.close();
		};
	});
	let bolt = $state.raw<ShellBolt | null>(null);
	const pageContext = () => {
		if (bolt === null) throw new Error('The workspace shell has not booted.');
		return bolt;
	};
	let failure = $state<{ code: string; message: string; status: number } | null>(null);
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
	/** What Norbius left for the person while its panel was closed: the dot on its icon, cleared on opening it. */
	let awaiting = $state<AwaitingKind | null>(null);
	const ended = (kind: SoundKind) => {
		if (agentRequest === null) awaiting = awaitingAfter(awaiting, kind);
	};
	watch(
		() => agentRequest !== null,
		(open) => {
			if (open) awaiting = null;
		}
	);
	const agentParam = $derived(url.searchParams.get('agent'));
	watch(
		() => agentParam,
		(p) => {
			if (p === null) return void (agentRequest !== null && agent.close());
			const conversation = p === 'new' ? null : p;
			// a panel that has not reported its conversation yet keeps the one it chose
			if (
				agentRequest === null ||
				(agentRequest.conversation !== undefined && agentRequest.conversation !== conversation)
			)
				agent.open({ ...agentRequest, conversation });
		}
	);
	/** The panel switched conversation: the URL follows without a history entry. */
	function agentConversation(id: string | null): void {
		if (agentRequest !== null) agentRequest = { ...agentRequest, conversation: id };
		agentUrl(id ?? 'new', true);
	}
	// ui's generated forms and record views: the caller's exposure from the boot, pickers paging through `bolt.read`
	provideKinds({
		get catalog() {
			return boot?.catalog;
		},
		get automations() {
			return boot?.automations;
		},
		get locale() {
			return locale;
		},
		get zone() {
			return boot?.workspace.tz;
		},
		// a money field without its own currency reads in the workspace's (X-8)
		get currency() {
			return config.manifest.workspace.currency;
		},
		query: (request) => pageContext().query(request),
		// a generated form's file field: bytes to `<model>.<field>`, links to the stored file
		upload: (file, target) =>
			pageContext()
				.upload(file, target)
				.pipe(Effect.map((ref) => ({ id: ref.id, name: ref.name, mime: ref.mime }))),
		file_url: (ref, options) => pageContext().file_url(ref, options),
		get customFields() {
			return config.customFields;
		}
	});
	// the record views of every `RecordShell` under the shell, the `?record=` sheet's and a page's alike
	// a page's AppShell publishes its identity and actions here; the hero above the page renders them
	const identity = $state<AppIdentitySlot>({ current: null });
	setAppIdentitySlot(identity);
	// svelte-ignore state_referenced_locally
	provideRepresentations(config.representations ?? {});

	// The UI kit's controls share the client of this shell mount.
	provideBolt(pageContext);

	// a preview environment drops the meta tools: Norbius and Studio (`surfaces`), People, Integrations and preview-as
	const previewEnv = $derived(boot?.workspace.live !== undefined);
	const current = $derived(previewRoute(route(config.manifest, url), previewEnv));
	const commandTabs = $derived(
		boot === null ? [] : commandCenterTabs(boot.surfaces, boot.admin, previewEnv)
	);
	// the record-sheet stack (rule 10): every `?record=`, the last on top
	const records = $derived(recordsOf(url));
	// a `portal: true` page or any kiosk page renders alone: no sidebar, banner, tabs, finder or agent; the way out is the URL bar
	// the device access the open app declares (`requires`); its pages wait behind the wall until it is granted
	const requires = $derived(
		current.kind === 'page' ? (config.manifest.apps[current.app]?.requires ?? []) : []
	);
	const device = $derived(bolt?.device ?? resolveDevice(config.device));
	const access = $derived(deviceAccess(device));
	const portal = $derived(
		current.kind === 'kiosk' ||
			(current.kind === 'page' &&
				config.manifest.apps[current.app]?.pages[current.page]?.portal === true)
	);
	const publicApp = $derived(
		current.kind === 'page' && isOpenRoute(config.manifest, current) ? current.app : undefined
	);
	let firstPageReady = $state(false);
	const initialPageMounted = attach(() =>
		Effect.promise(tick).pipe(
			Effect.tap(() =>
				Effect.sync(() => {
					firstPageReady = true;
				})
			)
		)
	);
	watch(
		() =>
			failure !== null ||
			(boot !== null &&
				((current.kind !== 'page' && current.kind !== 'kiosk') ||
					firstPageReady ||
					pageKey === null ||
					config.pages[pageKey] === undefined)) ||
			current.kind === 'signIn' ||
			current.kind === 'invite',
		(ready) => {
			if (ready)
				void (config.ready ?? Promise.resolve())
					.then(tick)
					.then(() => document.getElementById('bolt-loading')?.remove());
		}
	);

	/** `href` is a workspace URL (`/inbox`); the history entry carries the base path. */
	function navigate(href: string, replace = false): void {
		const next = new URL(href, url);
		if (next.origin !== location.origin) return void fork(openExternal(device, next.href));
		const destination = route(config.manifest, next);
		const publicKey =
			destination.kind === 'page'
				? `app/${destination.app}/${destination.page}`
				: destination.kind === 'kiosk'
					? `kiosk/${destination.kiosk}/${destination.page}`
					: null;
		if (publicKey !== null && config.publicRoutes?.includes(publicKey)) {
			location.assign(`${based(next.pathname)}${next.search}${next.hash}`);
			return;
		}
		history[replace ? 'replaceState' : 'pushState'](
			null,
			'',
			`${based(next.pathname)}${next.search}${next.hash}`
		);
		url = next;
	}
	/** The command center's open automation run is `?run=<id>`, beside whatever the table keeps in the URL. */
	function openRun(id: string | null): void {
		const next = here();
		if (id === null) next.searchParams.delete('run');
		else next.searchParams.set('run', id);
		navigate(next.href);
	}
	// in-app links are plain anchors; the shell keeps them in the page
	function intercept(event: MouseEvent): void {
		const a = (event.target as Element | null)?.closest?.('a');
		// a link out of the workspace opens through the shell, when it has a way
		if (
			a !== null &&
			a !== undefined &&
			!event.defaultPrevented &&
			event.button === 0 &&
			device.navigation !== undefined &&
			new URL(a.href, location.href).origin !== location.origin
		) {
			event.preventDefault();
			fork(openExternal(device, a.href));
			return;
		}
		if (
			a === null ||
			a === undefined ||
			event.defaultPrevented ||
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey ||
			a.target ||
			a.hasAttribute('download') ||
			a.hasAttribute('data-sveltekit-reload')
		)
			return;
		const next = logical(a.href);
		if (next === null || next.pathname.startsWith('/__bolt/')) return;
		event.preventDefault();
		navigate(next.href);
	}

	/**
	 * The boot follows the audience, and a public page boots its visitor, so the audience changes as the reader moves. Boots
	 * overlap, so each carries a ticket: a boot a later change superseded must commit nothing, or its `bolt` would replace —
	 * and close — the newer one, and its `boot` would describe a route the reader has left.
	 */
	let pageScope: Scope.Closeable | null = null;
	/** A signed-in staff member's device environment (notices, push, the shell's notice service). */
	let environment: { readonly signOut: Effect.Effect<void> } | null = null;
	let requestLoad: ((app: string | undefined, kiosk: string | null) => void) | null = null;
	const load = (app: string | undefined, kiosk: string | null) =>
		Effect.gen(function* () {
			const result = yield* Effect.result(api.boot(app, kiosk ?? undefined));
			if (result._tag === 'Failure') {
				boot = null;
				guest = result.failure.workspace ?? null;
				if (result.failure.status === 401 && !isOpenRoute(config.manifest, current))
					navigate(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, true);
				else if (
					result.failure.status !== 401 ||
					(current.kind !== 'signIn' && current.kind !== 'invite')
				)
					failure = {
						code: result.failure.code,
						message: result.failure.message,
						status: result.failure.status
					};
				return;
			}
			if (pageScope !== null) yield* Scope.close(pageScope, Exit.void);
			const scope = yield* Scope.make();
			pageScope = scope;
			const client = yield* shellBolt(result.success, {
				messages: { ...framework, ...config.messages },
				...(config.integrationSetups === undefined
					? {}
					: { integrationSetups: config.integrationSetups }),
				...(config.device === undefined ? {} : { device: config.device }),
				...(challenge === null ? {} : { challenge }),
				agent,
				kiosk: () => {
					const next = route(config.manifest, url);
					return next.kind === 'kiosk' ? next.kiosk : null;
				},
				...(config.fetch === undefined ? {} : { fetch: config.fetch }),
				...(config.openStream === undefined ? {} : { openStream: config.openStream })
			}).pipe(Effect.provideService(Scope.Scope, scope));
			// a preview shows only in Studio's or Norbius's frame (Norbius's own browser marks its view `?frame`);
			// opened as a page of its own it goes to the live workspace's Studio, which frames it
			const live = result.success.workspace.live;
			if (live !== undefined && window.self === window.top && !url.searchParams.has('frame'))
				return void location.replace(`${live.replace(/\/$/, '')}/studio`);
			failure = null;
			boot = result.success;
			refreshed = null;
			bolt = client;
			environment = result.success.surfaces.inbox
				? yield* deviceSession(client.device, {
						inbox: client.observe({ read: { m: 'inbox', a: [] } }),
						vapid: result.success.push,
						navigate,
						store: (body) => api.push(body)
					}).pipe(Effect.provideService(Scope.Scope, scope))
				: null;
			let lapsed = false;
			yield* client.sync.pipe(
				Stream.runForEach((state) =>
					Effect.gen(function* () {
						sync = state;
						if (state === 'closed') lapsed = true;
						if (state !== 'live' || !lapsed) return;
						lapsed = false;
						// a release closed the link and it is back: only another client needs a reload
						const next = yield* api.boot(publicApp, kioskRoute ?? undefined).pipe(Effect.option);
						if (
							Option.isSome(next) &&
							next.value.client !== undefined &&
							next.value.client === boot?.client
						)
							return;
						const leaving = new Event('beforeunload', { cancelable: true });
						window.dispatchEvent(leaving);
						if (!leaving.defaultPrevented) location.reload();
					})
				),
				Effect.forkIn(scope)
			);
		});
	const mountLifecycle = attach(() =>
		Effect.gen(function* () {
			challenge = yield* challengeQueue();
			const submit = yield* FiberHandle.makeRuntime<never, never, void>();
			requestLoad = (app, kiosk) => {
				submit(load(app, kiosk));
			};
			requestLoad(publicApp, kioskRoute);
			yield* SubscriptionRef.changes(updating).pipe(
				Stream.runForEach((n) =>
					Effect.sync(() => {
						waitingOutUpdate = n > 0;
					})
				),
				Effect.forkScoped
			);
			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					requestLoad = null;
					if (pageScope !== null) yield* Scope.close(pageScope, Exit.void);
					pageScope = null;
				})
			);
			yield* Effect.never;
		})
	);
	// the boot follows the audience: a public page boots its visitor, a kiosk its kiosk, everything else the session
	const kioskRoute = $derived(current.kind === 'kiosk' ? current.kiosk : null);
	// lazy: the mount's own load is the first; an eager run would boot twice, cancelling the first request
	watch(
		() => [publicApp, kioskRoute] as const,
		([app, kiosk]) => requestLoad?.(app, kiosk),
		{ lazy: true }
	);

	const refreshNotice = () =>
		fork(
			api.boot(publicApp, kioskRoute ?? undefined).pipe(
				Effect.map((next) => {
					refreshed = next;
				})
			),
			() => {}
		);

	function pageOf(key: string): Promise<Component<{ ctx: ShellBolt }>> | null {
		const chunk = config.pages[key];
		return chunk === undefined ? null : chunk().then((m) => m.default);
	}
	// keyed by a string: a query change (`?record=`) re-derives `current` but must not remount the page
	// a member's page outside their nav (another audience's app, or one no policy names) is no access, not rendered
	const pageKey = $derived(
		bolt === null
			? null
			: current.kind === 'page'
				? boot?.visitor === null && !navApps(boot.nav).includes(current.app)
					? null
					: `${current.app}/${current.page}`
				: current.kind === 'kiosk'
					? `kiosk/${current.kiosk}/${current.page}`
					: null
	);
	// a page chunk loads once: switching between an app's pages keeps its banner and tabs mounted, shows the page at once
	// when it has loaded before, and keeps the previous page of the same app on screen until a new chunk arrives
	const loaded = new SvelteMap<string, Component<{ ctx: ShellBolt }>>();
	const unloadable = new SvelteMap<string, unknown>();
	const loading = new Set<string>();
	const loadPage = (key: string) => {
		const chunk = loaded.has(key) || loading.has(key) ? null : pageOf(key);
		if (chunk === null) return;
		loading.add(key);
		chunk.then(
			(component) => loaded.set(key, component),
			(cause: unknown) => unloadable.set(key, cause)
		);
	};
	watch(
		() => pageKey,
		(key) => {
			if (key !== null) loadPage(key);
		}
	);
	let held: { key: string; Page: Component<{ ctx: ShellBolt }> } | undefined;
	const Page = $derived.by(() => {
		const ready = pageKey === null ? undefined : loaded.get(pageKey);
		if (pageKey !== null && ready !== undefined) held = { key: pageKey, Page: ready };
		const sameApp = held !== undefined && pageKey?.split('/')[0] === held.key.split('/')[0];
		return ready ?? (sameApp ? held?.Page : undefined);
	});

	const pageIdentity = $derived(Page === undefined ? null : identity.current);

	const signOut = Effect.fn('Shell.signOut')(function* () {
		if (environment !== null) yield* environment.signOut;
		yield* Effect.result(api.signOut());
		location.assign(based('/sign-in'));
	});
	const endPreview = Effect.fn('Shell.endPreview')(function* () {
		yield* Effect.result(api.preview(null));
		location.reload();
	});
	// ⌘K (Ctrl+K) opens Norbius, or closes it when open; ⌘/ (Ctrl+/) opens the finder; ⌘B (Ctrl+B) folds the sidebar
	let finding = $state(false);
	watch(
		() => url.searchParams.get('find'),
		(scope) => {
			if (scope !== null) finding = true;
		}
	);
	function shortcut(event: KeyboardEvent): void {
		if (!commandKey(event) || boot === null || boot.visitor !== null) return;
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
		if (agentRequest === null) agent.open();
		else agent.close();
	}
	// L-BOLT-499: the live link's state; `closed` means a release closed it: it comes back, and another client reloads
	let sync = $state<SyncStatus>('idle');
	// a release cutover holds the host closed for seconds: requests wait it out, and one notice says why
	let waitingOutUpdate = $state(false);
	// the sidebar on wide screens; on narrow ones ui's Drawer, which closes once its user navigates (owner rule)
	const expanded = new PersistedState('workspace-shell.sidebar-expanded', true);
	let navOpen = $state(false);
	/** What waits on the viewer, as the inbox last counted it (boot's count until then). */
	let waiting = $state<number | null>(null);
	const model = $derived(
		boot === null
			? null
			: navigationModel(waiting === null ? boot : { ...boot, inbox: waiting }, url.pathname, t)
	);
	const sessions = $derived(
		boot?.visitor === null
			? navApps(boot.nav).flatMap((name) =>
					config.sessions?.[name] === undefined ? [] : [{ name, component: config.sessions[name] }]
				)
			: []
	);
	const app = $derived(model === null ? null : activeApp(model));
	// the open app's pages strip is tab level 1 (ui's `TAB_LEVEL` context): a page's own Tabs nest under it as level 2
	const strip = $derived(
		current.kind === 'page' && !portal && boot?.visitor === null ? (app?.pages ?? null) : null
	);
	setContext(TAB_LEVEL, {
		get level() {
			return strip === null ? undefined : 1;
		},
		get shown() {
			return strip?.map((p) => p.label) ?? [];
		}
	});
	const mobileTitle = $derived(
		pageIdentity?.title ??
			app?.label ??
			[...(model?.sections.flatMap((s) => s.items) ?? []), ...(model?.utilities ?? [])].find(
				(i) => i.active
			)?.label ??
			boot?.workspace.name ??
			''
	);
	const mobileDescription = $derived(pageIdentity?.description ?? app?.description ?? null);
	// the open app's identity (its AppShell's once published, the registry's until then): the desktop hero, the phone's bar
	const hero = $derived(
		(current.kind === 'page' || current.kind === 'kiosk') &&
			!portal &&
			(pageIdentity !== null || (app !== null && boot?.visitor === null))
			? {
					src:
						pageIdentity?.banner === undefined || pageIdentity.banner === null
							? (app?.thumbnail ?? null)
							: media(pageIdentity.banner),
					icon: pageIdentity?.icon ?? app?.icon ?? null,
					title: pageIdentity?.title ?? app?.label ?? null,
					description: pageIdentity?.description ?? app?.description ?? null,
					actions: pageIdentity?.actions
				}
			: null
	);
	// an administrator's team preview from the account menu: the teams Settings lists
	const teams = Effect.fn('Shell.teams')(function* () {
		const r = yield* Effect.result(api.settings());
		return r._tag === 'Success'
			? r.success.teams.map((x) => ({ id: String(x['id']), name: String(x['name'] ?? x['id']) }))
			: [];
	});
	const previewTeam = Effect.fn('Shell.previewTeam')(function* (team: string) {
		yield* Effect.result(api.preview({ team }));
		location.reload();
	});
	// the 48rem breakpoint base.css restates: below it the sidebar is a drawer
	const narrow = new MediaQuery('max-width: 47.999rem');
	const go = (href: string) => {
		if (href !== NORBIUS) return navigate(href);
		navOpen = false;
		agent.open();
	};
	setContext<ClientNavigation>(CLIENT_NAVIGATION, {
		open(path, conversation) {
			if (
				boot === null ||
				boot.actor?.kind !== 'member' ||
				boot.actor.external ||
				previewEnv ||
				!clientNavigationPath(path, navigationPaths(boot.nav, boot.admin), boot.admin)
			)
				return;
			const next = new URL(path, url);
			next.searchParams.set('agent', conversation);
			if (next.searchParams.has('setup')) {
				next.searchParams.set('setupRequest', crypto.randomUUID());
				// a native form is the point: the panel would sit exactly over its sheet
				next.searchParams.delete('agent');
			}
			navigate(next.href);
		}
	});
	// closing a sheet closes every sheet stacked on it
	const closeRecord = (depth: number) => navigate(withRecords(url, depth).href);

	/** The active tab's claim on a page action: the server lets exactly one tab own it, across windows and devices. */
	const claimedBy = (output: unknown): boolean =>
		typeof output === 'object' && output !== null && 'claimed' in output && output.claimed === true;

	/** The page settles first: what it then shows reaches Norbius with the answer. */
	const answerPage = (step: string, result: PageResult) =>
		setTimeout(() => {
			void run(api.agent.pageResult(step, { ...result, screen: pageScreen() })).catch(() => {});
		}, 700);
	setContext<ClientPageAction>(CLIENT_PAGE_ACTION, {
		arrived(step) {
			if (document.visibilityState === 'visible') answerPage(step, { ok: true });
		},
		run(action, _conversation, step) {
			const ack = (result: PageResult) => answerPage(step, result);
			// a hidden or ineligible tab stays silent: a second tab must never overwrite the acting tab's result
			if (
				boot === null ||
				boot.actor?.kind !== 'member' ||
				boot.actor.external ||
				previewEnv ||
				document.visibilityState !== 'visible'
			)
				return;
			const act = () => {
				if (action.highlight !== undefined) {
					const target = pageMark(action.highlight);
					if (target === null) {
						ack({ ok: false, note: `Nothing visible reads “${action.highlight}”.` });
						return;
					}
					target.scrollIntoView({ block: 'center' });
					// the panel must not sit over what it points at
					if (pageCovered(target)) agent.close();
					ringOn(target);
					ack({ ok: true, note: `Highlighted “${action.highlight}”.` });
					return;
				}
				if (action.scroll !== undefined) {
					let scroller: HTMLElement | null = document.querySelector<HTMLElement>('main');
					while (scroller !== null && scroller.scrollHeight <= scroller.clientHeight + 1)
						scroller = scroller.parentElement;
					(scroller ?? document.scrollingElement ?? window).scrollBy({
						top: action.scroll,
						behavior: 'smooth'
					});
					ack({ ok: true, note: `Scrolled ${action.scroll}px.` });
					return;
				}
				if (action.go !== undefined) {
					if (action.go === 'back') history.back();
					else history.forward();
					ack({ ok: true, note: `Went ${action.go}.` });
					return;
				}
				if (action.type !== undefined) {
					const fill = action.type;
					const field = pageField(fill.label);
					if (field === null) {
						ack({ ok: false, note: `No visible field “${fill.label}”.` });
						return;
					}
					const shown = fill.text.length > 120 ? `${fill.text.slice(0, 120)}…` : fill.text;
					fork(
						confirmAction({
							title: t('Norbius wants to type into this page'),
							body: t('Fill “{field}” with “{value}”? It can change your workspace.')
								.replace('{field}', pageFieldLabel(field) || fill.label)
								.replace('{value}', shown),
							confirmLabel: t('Fill it'),
							destructive: true
						}).pipe(
							Effect.tap((yes) =>
								Effect.sync(() => {
									if (yes) {
										fillField(field, fill.text, fill.submit === true);
										ack({ ok: true, note: `Filled “${pageFieldLabel(field) || fill.label}”.` });
									} else ack({ ok: false, note: 'The person declined.' });
								})
							)
						)
					);
					return;
				}
				if (action.click === undefined) return;
				const control = pageClickable(action.click);
				if (control === null) {
					ack({ ok: false, note: `No visible control “${action.click}”.` });
					return;
				}
				// a board card is a record opener, not a mutation: it is the card the person sees.
				if (control.matches('[data-board-card]')) {
					control.click();
					ack({ ok: true, note: `Opened “${pageLabel(control)}”.` });
					return;
				}
				const link = control.closest<HTMLAnchorElement>('a[href]');
				if (link !== null && !link.hasAttribute('download')) {
					const next = logical(link.href);
					if (next !== null && !next.pathname.startsWith('/__bolt/')) {
						navigate(next.href);
						ack({ ok: true, url: next.href });
						return;
					}
					if (new URL(link.href, location.href).origin !== location.origin) {
						fork(
							confirmAction({
								title: t('Norbius wants to open a link'),
								body: t('Open “{link}” in your browser?').replace('{link}', link.href),
								confirmLabel: t('Open it')
							}).pipe(
								Effect.tap((yes) =>
									Effect.sync(() => {
										if (yes) {
											fork(openExternal(device, link.href));
											ack({ ok: true, note: 'Opened the external link.' });
										} else ack({ ok: false, note: 'The person declined.' });
									})
								)
							)
						);
						return;
					}
					ack({ ok: false, note: 'That link is outside the workspace.' });
					return;
				}
				fork(
					confirmAction({
						title: t('Norbius wants to use this page'),
						body: t('Press “{control}”? It can change your workspace.').replace(
							'{control}',
							pageLabel(control) || action.click
						),
						confirmLabel: t('Press it'),
						destructive: true
					}).pipe(
						Effect.tap((yes) =>
							Effect.sync(() => {
								if (yes) {
									control.click();
									ack({ ok: true, note: `Pressed “${pageLabel(control)}”.` });
								} else ack({ ok: false, note: 'The person declined.' });
							})
						)
					)
				);
			};
			void run(api.agent.claimPageAction(step))
				.then((answer) => {
					if (answer.kind === 'committed' && claimedBy(answer.output)) act();
				})
				.catch(() => {});
		}
	});
</script>

<svelte:head
	>{#if workspace !== null}<title>{workspace.name}</title>{/if}</svelte:head
>

{#if bolt !== null}
	{#key bolt}
		{#each sessions as session (session.name)}
			{@const Session = session.component}
			<Session ctx={bolt} />
		{/each}
	{/key}
{/if}

<span hidden {@attach mountLifecycle}></span>
{#if waitingOutUpdate}
	<Inline
		role="status"
		gap="sm"
		class="fixed inset-x-0 bottom-4 z-50 mx-auto w-fit rounded-full border bg-background px-3 py-1.5 text-xs shadow-sm"
	>
		<Spinner class="size-3.5" />{t('Updating to a new version…')}
	</Inline>
{/if}

<svelte:window onpopstate={() => (url = here())} onkeydown={shortcut} />

{#snippet openingFeature()}
	<Center><p role="status">{t('Loading…')}</p></Center>
{/snippet}

{#snippet failedFeature()}
	<Center><p role="alert">{t('The page could not be rendered.')}</p></Center>
{/snippet}

{#snippet content()}
	{#if current.kind === 'home' && model !== null}
		<Home
			{model}
			{t}
			onNavigate={navigate}
			onAsk={boot?.surfaces.agent ? (prompt) => agent.open({ prompt }) : null}
		/>
	{:else if current.kind === 'page' || current.kind === 'kiosk'}
		<!-- the open app's banner and its pages as tabs; on a phone the shell's top bar carries the banner, except a visitor's -->
		{#if hero !== null && (!narrow.current || boot?.visitor !== null)}
			<AppHeader {...hero} compact={narrow.current} actionsLabel={t('Page scope')} />
		{/if}
		{#if strip !== null}
			<div class={cn(INSET_X_CLASS, 'shrink-0 pt-3')}>
				<TabStrip
					label={t('Pages')}
					level={1}
					value={strip.find((p) => p.active)?.key}
					items={strip.map((p) => ({
						name: p.key,
						title: p.label,
						href: based(p.href),
						...(p.icon ? { icon: p.icon } : {})
					}))}
				/>
			</div>
		{/if}
		{#if pageKey === null || config.pages[pageKey] === undefined}
			<Center><p>{t('Not found or no access')}</p></Center>
		{:else if unloadable.has(pageKey)}
			{@const cause = unloadable.get(pageKey)}
			<span hidden {@attach initialPageMounted}></span>
			<!-- a page chunk that fails to load says which page and why (final-ui §7.2, L-BOLT-515) -->
			<Center
				><p role="alert">
					{t('The page {page} could not be loaded:').replace('{page}', pageKey)}
					{cause instanceof Error ? cause.message : String(cause)}
				</p></Center
			>
		{:else if Page === undefined}
			<div
				class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
				role="status"
				aria-busy="true"
				aria-label={t('Loading…')}
			>
				<TableSkeleton />
			</div>
		{:else}
			<span hidden {@attach initialPageMounted}></span>
			<!-- hook:view-ui — a page sits inset from the sidebar; a page's own AppShell inset finds this owner and stays flush -->
			<svelte:boundary>
				{#if requires.length === 0}
					<Bound size="fill" inset><Page ctx={pageContext()} /></Bound>
				{:else}
					<DeviceWall {requires} {access} native={device.geolocation?.source === 'native'} {t}>
						<Bound size="fill" inset><Page ctx={pageContext()} /></Bound>
					</DeviceWall>
				{/if}
				{#snippet failed(error)}
					<span hidden {@attach initialPageMounted}></span>
					<Center
						><p role="alert">
							{t('The page could not be rendered.')}
							{error instanceof Error ? error.message : String(error)}
						</p></Center
					>
				{/snippet}
			</svelte:boundary>
		{/if}
	{:else if current.kind === 'inbox' && boot?.surfaces.inbox && bolt}
		<Inbox {bolt} {t} onCount={(n) => (waiting = n)} />
	{:else if current.kind === 'settings' && boot?.surfaces.settings && bolt}
		{#await import('./settings/Settings.svelte')}
			{@render openingFeature()}
		{:then { default: Settings }}
			<Settings
				{configuration}
				{api}
				{bolt}
				{t}
				tab={current.tab}
				workspace={boot.workspace}
				integrationSetups={config.integrationSetups}
			/>
		{:catch}
			{@render failedFeature()}
		{/await}
	{:else if current.kind === 'commandCenter' && commandTabs.length > 0 && boot !== null && bolt}
		{#await import('./command-center/CommandCenter.svelte')}
			{@render openingFeature()}
		{:then { default: CommandCenter }}
			<CommandCenter
				automation={url.searchParams.get('automation')}
				onAutomationClose={() => {
					if (url.searchParams.has('automation')) {
						const next = new URL(url);
						next.searchParams.delete('automation');
						navigate(next.href, true);
					}
				}}
				{configuration}
				{api}
				{bolt}
				{t}
				tabs={commandTabs}
				tab={current.tab}
				onTab={(x) => navigate(`/command-center/${x}`)}
				admin={boot.admin}
				startable={boot.startable ?? []}
				run={url.searchParams.get('run')}
				onRun={openRun}
				onConversation={boot.surfaces.agent ? (conversation) => agent.open({ conversation }) : null}
			/>
		{:catch}
			{@render failedFeature()}
		{/await}
	{:else if current.kind === 'studio' && boot?.surfaces.studio}
		<StudioSlot
			bundle={boot.studioBundle}
			props={{
				t,
				locale,
				uiText,
				file: url.searchParams.get('file'),
				onFile: (path) => {
					const next = new URL(url);
					next.pathname = '/studio';
					next.searchParams.set('file', path);
					navigate(next.href);
				},
				admin: boot.admin,
				tab: current.tab ?? 'workbench',
				onTab: (x) => navigate(x === 'workbench' ? '/studio' : `/studio/${x}`),
				onAsk: boot.surfaces.agent
					? (prompt) => agent.open({ prompt, send: crypto.randomUUID() })
					: null
			}}
		/>
	{:else}
		<Center><p>{t('Not found or no access')}</p></Center>
	{/if}
	{#if bolt !== null}
		{#each records as r, i (`${i}:${r.model}/${r.id}`)}
			<RecordSheet model={r.model} id={r.id} onClose={() => closeRecord(i)} />
		{/each}
	{/if}
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<!-- hook:view-ui — the sidebar's width, the left bound of a maximised or widened right sheet (0 where no sidebar shows) -->
<div
	class="contents"
	onclick={intercept}
	style="--shell-sidebar-width: {boot !== null &&
	boot.visitor === null &&
	!portal &&
	!narrow.current &&
	failure === null
		? expanded.current
			? '16rem'
			: '3rem'
		: '0px'}"
>
	{#if failure !== null}
		<Access
			{t}
			environment={workspace?.environment}
			{locale}
			onLocale={(locale) => fork(setLocale(locale))}
			apex={device.pinned ? undefined : workspace?.apex}
			{dark}
			onTheme={() => chooseTheme(dark ? 'light' : 'dark')}
		>
			<Stack gap="lg" role="alert">
				<Stack gap="sm">
					<p class="text-xs text-muted-foreground">
						{failure.status === 0 ? t('Connection error') : `HTTP ${failure.status}`} · {failure.code}
					</p>
					<h1 class="text-title">{t('Unable to open the workspace')}</h1>
					<p class="text-sm leading-relaxed text-muted-foreground">{t(failure.message)}</p>
				</Stack>
				<Button onclick={() => location.reload()}>{t('Try again')}</Button>
			</Stack>
		</Access>
	{:else if current.kind === 'signIn' || current.kind === 'invite'}
		<Access
			{t}
			environment={workspace?.environment}
			{locale}
			onLocale={(locale) => fork(setLocale(locale))}
			apex={device.pinned ? undefined : workspace?.apex}
			{dark}
			onTheme={() => chooseTheme(dark ? 'light' : 'dark')}
		>
			{#if current.kind === 'signIn'}
				<SignIn
					{api}
					{t}
					next={current.next ?? '/'}
					workspace={workspace?.name ?? config.workspaceName}
					handle={workspace?.handle}
				/>
			{:else}
				<Invite
					{api}
					{t}
					id={current.id}
					signedIn={boot?.actor?.kind === 'member'}
					workspace={workspace?.name ?? config.workspaceName}
				/>
			{/if}
		</Access>
	{:else if boot === null}
		<Center><p>{t('Loading…')}</p></Center>
	{:else if boot.visitor !== null}
		<!-- a visitor page: only its own app, no switcher, inbox, agent, settings or runs -->
		<Cover as="main" class="min-h-dvh pb-[env(safe-area-inset-bottom)]">
			{@render content()}
			{#if boot.visitor.siteKey !== undefined}
				{#if challenge !== null}<Turnstile siteKey={boot.visitor.siteKey} queue={challenge} />{/if}
			{/if}
		</Cover>
	{:else if portal}
		<Toaster />
		<div
			class="relative h-dvh min-h-0 overflow-clip pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
		>
			{@render content()}
		</div>
	{:else}
		{#snippet navigation(open: boolean)}
			<Nav
				pinned={device.pinned === true}
				model={model!}
				expanded={open}
				mobile={narrow.current}
				{t}
				environment={boot?.workspace.environment ?? null}
				{locale}
				onLocale={(locale) => fork(setLocale(locale))}
				{theme}
				onTheme={chooseTheme}
				{chimes}
				{awaiting}
				onSounds={() => {
					navOpen = false;
					soundsOpen = true;
				}}
				{sync}
				previewing={boot?.preview !== null}
				onEndPreview={() => fork(endPreview())}
				{...boot?.admin && boot.surfaces.settings && boot.preview === null && !previewEnv
					? {
							loadTeams: () => run(teams()),
							onPreviewTeam: (team: string) => fork(previewTeam(team))
						}
					: {}}
				onSearch={() => {
					navOpen = false;
					finding = true;
				}}
				onNavigate={go}
				onSignOut={signOut}
				notice={(refreshed ?? boot)?.notice}
				{...narrow.current ? {} : { onToggle: () => (expanded.current = !expanded.current) }}
			>
				{#snippet bell(wide)}{#if bolt !== null && !narrow.current}<Bell
							{api}
							{bolt}
							{t}
							expanded={wide}
							onArrival={refreshNotice}
							onNavigate={(href) => {
								navOpen = false;
								navigate(href);
							}}
						/>{/if}{/snippet}
			</Nav>
		{/snippet}
		<Toaster />
		<!-- relative: an out-of-flow descendant without a positioned ancestor (an sr-only label deep in a scroll port) is
		     clipped here instead of growing the document past the viewport -->
		<div class="relative flex h-dvh min-h-0 overflow-clip">
			{#if !narrow.current}
				<!-- Sidebar: 16rem, or a 3rem icon rail; the rail on its edge toggles it (⌘B) -->
				<aside
					class="group relative shrink-0 border-r transition-[width] duration-200 ease-linear"
					data-state={expanded.current ? 'expanded' : 'collapsed'}
					style="width: {expanded.current ? '16rem' : '3rem'}"
				>
					{@render navigation(expanded.current)}
					<button
						type="button"
						tabindex={-1}
						aria-label={t('Toggle sidebar')}
						title={t('Toggle sidebar')}
						onclick={() => (expanded.current = !expanded.current)}
						class={cn(
							'absolute inset-y-0 -right-2 z-20 w-4 after:absolute after:inset-y-0 after:left-[calc(50%-1px)] after:w-[2px] hover:after:bg-sidebar-border',
							expanded.current ? 'cursor-w-resize' : 'cursor-e-resize'
						)}
					></button>
				</aside>
			{/if}
			<main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-clip bg-background">
				{#if narrow.current}
					<!-- the phone's one top bar: navigation, the open app's identity over its banner, the bell, Norbius, then the page's scope -->
					<div class="shrink-0">
						<AppHeader
							compact
							src={hero?.src ?? null}
							icon={hero?.icon ?? null}
							title={mobileTitle}
							description={mobileDescription}
							actions={hero?.actions}
							actionsLabel={t('Page scope')}
						>
							{#snippet leading()}
								<Button
									variant="ghost"
									size="icon"
									class="size-11"
									aria-label={t('Open navigation')}
									onclick={() => (navOpen = true)}
								>
									<Icon name="lucide:panel-bottom" class="size-4" />
								</Button>
							{/snippet}
							{#snippet trailing()}
								{#if bolt !== null}<Bell
										{api}
										{bolt}
										{t}
										expanded={false}
										header
										onArrival={refreshNotice}
										onNavigate={navigate}
									/>{/if}
								{#if boot?.surfaces.agent}
									<Button
										variant="ghost"
										size="icon"
										class="relative size-11"
										aria-label={t('Norbius')}
										aria-haspopup="dialog"
										onclick={() => agent.open()}
									>
										<NorbiusStrip size={20} />
										<Awaiting kind={awaiting} {t} />
									</Button>
								{/if}
							{/snippet}
						</AppHeader>
					</div>
				{/if}
				<Stack gap="none" size="fill" class="pb-[env(safe-area-inset-bottom)] md:pb-0">
					{#if sync === 'closed'}
						<Inline role="alert" justify="between" class="bg-warning/15 px-4 py-2 text-xs">
							<span
								>{t('This workspace was updated. Reload to continue with the new version.')}</span
							>
							<Button variant="outline" onclick={() => location.reload()}>{t('Reload')}</Button>
						</Inline>
					{/if}
					{#if boot.preview !== null}
						<Inline role="status" justify="between" class="bg-warning/15 px-4 py-2 text-xs">
							<span
								>{'team' in boot.preview
									? t('Previewing as a team. Its grants apply; you are recorded as the previewer.')
									: t(
											'Previewing as another member. Their grants apply; you are recorded as the previewer.'
										)}</span
							>
							<Button variant="outline" onclick={() => fork(endPreview())}
								>{t('End preview')}</Button
							>
						</Inline>
					{/if}
					{@render content()}
				</Stack>
			</main>
			{#if narrow.current}
				<Drawer bind:open={navOpen} path={url.pathname + url.search} title={boot.workspace.name}
					>{@render navigation(true)}</Drawer
				>
			{/if}
		</div>
		{#if bolt !== null}
			<Finder
				bind:open={finding}
				entries={boot.search ?? []}
				initialScope={url.searchParams.get('find')}
				onClose={() => {
					if (url.searchParams.has('find')) {
						const next = new URL(url);
						next.searchParams.delete('find');
						navigate(next.href);
					}
				}}
				nav={boot.nav}
				catalog={boot.catalog}
				read={(request) => bolt!.query<FinderAnswer>(request)}
				{t}
				onNavigate={navigate}
				onOpenRecord={(c, id) => openRecord(c, id)}
				onAsk={boot.surfaces.agent ? (prompt) => agent.open({ prompt }) : null}
			/>
		{/if}
		{#if boot.surfaces.inbox && bolt !== null}
			<Waiting {bolt} onCount={(n) => (waiting = n)} />
		{/if}
		{#if boot.surfaces.agent && bolt !== null}
			<Attention {bolt} active={agentRequest?.conversation ?? null} onEnded={ended} />
			<!-- non-modal, as every side sheet: the page stays usable; only Esc or × closes it -->
			<Sheet
				open={agentRequest !== null}
				title={t('Norbius')}
				onOpenChange={(open) => {
					if (!open) agent.close();
				}}
			>
				{#if agentRequest !== null && config.agent !== undefined}
					{@const Agent = config.agent}
					<Agent {bolt} request={agentRequest} onClose={() => agent.close()} />
				{:else if agentRequest !== null}
					{#await import('./agent/Agent.svelte')}
						{@render openingFeature()}
					{:then { default: AgentPanel }}
						<AgentPanel
							{api}
							{bolt}
							{t}
							catalog={bolt.catalog}
							zone={bolt.tz}
							nav={boot.nav}
							entries={boot.search ?? []}
							request={agentRequest}
							unconfigured={boot.aiUnconfigured === true}
							admin={boot.admin}
							envoys={boot.envoys ?? {}}
							onClose={() => agent.close()}
							onConversation={agentConversation}
							storageKey={agentMemory}
						/>
					{:catch}
						{@render failedFeature()}
					{/await}
				{/if}
			</Sheet>
		{/if}
		<Sheet open={soundsOpen} title={t('Sounds')} onOpenChange={(open) => (soundsOpen = open)}>
			<SoundSettings
				enabled={chimes}
				status={soundStatus}
				onChange={chooseChimes}
				onTest={() => {
					void sounds.test();
				}}
				{t}
			/>
		</Sheet>
	{/if}
</div>
