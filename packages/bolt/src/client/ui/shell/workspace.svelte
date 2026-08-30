<script lang="ts">
	import { Effect } from 'effect';
	import { untrack, type Component } from 'svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { humanize } from '@norbital-ai/std/string';
	import type { CollectionQuery, CollectionRecord } from '@norbital-ai/std/collection';
	import {
		setCollectionClientContext,
		setRelationshipDirectoryContext,
		setCollectionSurfaceRuntime,
		type CollectionSurface
	} from '@norbital-ai/ui/collection-runtime';
	import {
		setDataRendererRuntimeContext,
		type CustomTypeRendererState
	} from '@norbital-ai/ui/data-renderer';
	import BoltApp from './app.svelte';
	import { Scroll, Stack } from '@norbital-ai/ui/layout';
	import {
		WORKSPACE_HOST_PLUGINS,
		WORKSPACE_SETTINGS_PATH,
		hostPluginKeyFromPath
	} from '#lib/client/ui/shell/workspace-navigation.js';
	import WorkspaceMembers from '../settings/workspace.svelte';
	import { EMPTY_WORKSPACE_ACCESS } from '#lib/client/ui/settings/rows.js';
	import EnvoysSettings from '../org/envoys-settings.svelte';
	import OrganizationSettings from '../org/organization-settings.svelte';
	import SecretsSettings from '../org/secrets-settings.svelte';
	import StudioShell from '../studio/studio-shell.svelte';
	import { provideAgentClient } from '../agent/client.svelte.js';
	import { WEB_AGENT_ID } from '#lib/client/ui/agent/conversation-selector.js';
	import { WorkspaceUploadClient } from '../state/file-upload-client.svelte.js';
	import { workspaceSession } from '#lib/client/session.js';
	import type { ClientState } from '#lib/client/sync/machine.js';
	import type {
		CompiledWorkspace,
		WorkspaceHostActions,
		WorkspaceView
	} from '#lib/client/ui/shell/workspace-contract.js';

	/**
	 * The whole workspace UI, inside the tenant's own compiled bundle.
	 *
	 * This was the host's component. It rendered `BoltApp` and passed Workspace Studio, Organization,
	 * Agents and Environment secrets in as *children* — which only worked while the host compiled the
	 * tenant's apps into its own bundle, because a tenant bundle ships its own Svelte and its own copy
	 * of the design system, and two Svelte instances cannot share a component tree or a context key.
	 * Consolidating those four surfaces here is what lets the compiled bundle be consumed at all: the
	 * bundle owns the tree end to end and the host passes data and callbacks.
	 *
	 * Nothing here is read from the document. Every fact about who is signed in and which organization
	 * is routed arrives as `view`, which the host answers per navigation; every host capability
	 * arrives as the declared session. The `data-bolt-*` attributes this used to read are stamped when
	 * a *document* is served, and this shell mounts across navigations that serve none — which is how
	 * an organization switch could leave it rendering the previous tenant's workspace.
	 */
	let {
		view,
		workspace,
		actions
	}: {
		view: WorkspaceView;
		workspace: CompiledWorkspace;
		actions: WorkspaceHostActions;
	} = $props();

	const session = workspaceSession();
	let accessScope = $state(session.accessScope);
	let interactiveQueriesRequestedScope = $state<string | undefined>(undefined);
	const syncStatusSignal = untrack(() => workspace.syncStatus);
	let syncStatus = $state.raw<ClientState | undefined>(syncStatusSignal?.current());

	/**
	 * Mirrors the Machine's one sync state into this bundle's Svelte graph.
	 *
	 * No signal means no proof: leave the value absent so the shell says the connection state is
	 * unverified. It must never synthesize “live” from browser connectivity alone.
	 */
	$effect(() => syncStatusSignal?.subscribe((next) => (syncStatus = next)));

	/**
	 * The authored record surfaces, keyed by collection.
	 *
	 * A workspace declares what a record *is* in `+representation.svelte` — which fields belong on
	 * the sheet, in what order, through which renderer. `CollectionTable` looks for one here and falls
	 * back to the auto-emitted form.
	 *
	 * Filled in as each exact key is first read rather than awaited as a batch. These modules improve
	 * one record surface, but none decides which application the person may enter, so an unopened
	 * collection must never put its representation into the initial dependency graph.
	 */
	const loadedCollectionSurfaces = $state<Record<string, CollectionSurface>>({});
	const requestedCollectionSurfaces = new Set<string>();
	const collectionSurfaces = new Proxy(loadedCollectionSurfaces, {
		get: (surfaces, property, receiver) => {
			if (typeof property === 'string' && !requestedCollectionSurfaces.has(property)) {
				const load = workspace.representationLoaders[property];
				if (load !== undefined) {
					requestedCollectionSurfaces.add(property);
					void Effect.runPromise(
						Effect.tryPromise(load).pipe(
							Effect.tap((representation) =>
								Effect.sync(() =>
									Object.assign(loadedCollectionSurfaces, {
										[property]: { representation }
									})
								)
							),
							Effect.catch(() => Effect.void)
						)
					);
				}
			}
			return Reflect.get(surfaces, property, receiver);
		}
	});
	setCollectionSurfaceRuntime({
		appId: () => landingName ?? '',
		surfaces: collectionSurfaces,
		claimView: () => () => undefined
	});
	const safeUserDirectoryQuery = (query: unknown): CollectionQuery<CollectionRecord> => {
		const input =
			query !== null && typeof query === 'object' && !Array.isArray(query)
				? (query as Readonly<Record<string, unknown>>)
				: {};
		const rawWhere =
			input['where'] !== null &&
			typeof input['where'] === 'object' &&
			!Array.isArray(input['where'])
				? (input['where'] as Readonly<Record<string, unknown>>)
				: {};
		const where = Object.fromEntries(
			Object.entries(rawWhere).filter(([field]) => field === 'id' || field === 'name')
		) as Record<string, unknown>;
		const search = typeof input['search'] === 'string' ? input['search'].trim() : '';
		if (search.length > 0)
			where.name = {
				ilike: `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
			};
		const rawOrderBy =
			input['orderBy'] !== null &&
			typeof input['orderBy'] === 'object' &&
			!Array.isArray(input['orderBy'])
				? (input['orderBy'] as Readonly<Record<string, unknown>>)
				: {};
		const orderBy = Object.fromEntries(
			Object.entries(rawOrderBy).filter(
				([field, direction]) =>
					(field === 'id' || field === 'name') && (direction === 'asc' || direction === 'desc')
			)
		) as NonNullable<CollectionQuery<CollectionRecord>['orderBy']>;
		const requestedLimit =
			typeof input['limit'] === 'number' && Number.isInteger(input['limit']) ? input['limit'] : 100;
		return {
			columns: { id: true, name: true },
			where: where as NonNullable<CollectionQuery<CollectionRecord>['where']>,
			orderBy,
			limit: Math.max(1, Math.min(100, requestedLimit))
		};
	};
	setRelationshipDirectoryContext({
		findMany: (collectionName, query) =>
			collectionName === 'user'
				? workspace.frameworkClient.records.findMany('user', safeUserDirectoryQuery(query))
				: workspace.client.records.findMany(collectionName, query)
	});

	/**
	 * The workspace's own collection client, published for surfaces that have no table above them.
	 *
	 * A record sheet used to be rendered by whichever `CollectionTable` had registered it on mount,
	 * which meant a `?stack=` frame naming a table on an unopened tab had nothing to render with. The
	 * sheet now reads the record itself, and this is where it gets the public authored client to read
	 * it through — from the bundle, never from a host lookup.
	 *
	 * Runtime-owned collections stay on the separate framework client. The relationship renderer gets
	 * only a fixed safe `user` id/name projection through its private context above.
	 */
	// svelte-ignore state_referenced_locally -- the compiled workspace is fixed for this mount.
	setCollectionClientContext(() => workspace.client);

	/**
	 * A custom type's own renderer, keyed by the type name its columns declare and loaded when a
	 * `DataRenderer` first reads that exact kind.
	 *
	 * `custom('leave_event')` is a jsonb column whose shape only its author knows, so the type ships
	 * the component that reads it. Without these every custom field falls through to the JSON dump.
	 */
	const customTypeRendererStates = $state<Record<string, CustomTypeRendererState>>({});
	const requestedCustomTypeRenderers = new Set<string>();
	const customTypeRendererLoading = { status: 'loading' } as const;
	function customTypeRenderer(kind: string): CustomTypeRendererState | undefined {
		const current = customTypeRendererStates[kind];
		if (current) return current;
		const load = workspace.customTypeRendererLoaders[kind];
		if (!load) return undefined;
		if (!requestedCustomTypeRenderers.has(kind)) {
			requestedCustomTypeRenderers.add(kind);
			void Effect.runPromise(
				Effect.tryPromise(load).pipe(
					Effect.tap((renderer) =>
						Effect.sync(() =>
							Object.assign(customTypeRendererStates, {
								[kind]: { status: 'ready', renderer }
							})
						)
					),
					Effect.catch((cause) =>
						Effect.sync(() =>
							Object.assign(customTypeRendererStates, {
								[kind]: {
									status: 'failed',
									error: cause instanceof Error ? cause : new Error(String(cause))
								}
							})
						)
					)
				)
			);
		}
		return customTypeRendererStates[kind] ?? customTypeRendererLoading;
	}
	setDataRendererRuntimeContext({
		customTypeRenderer,
		// File records persist storage keys, never routes. The host owns the route and declares it on
		// the session, so generic renderers and authored representations resolve the same key through
		// the same capability.
		fileUrl: session.files.urlFor,
		// These two need a provider credential the host does not hold yet — they belong to the Secrets
		// vault. Refusing names what is missing; returning an empty result would render an address
		// picker that silently finds nothing and a map that is silently blank.
		autocompleteGeolocation: () =>
			Effect.fail(new Error('Geolocation autocomplete needs a provider credential in Secrets.')),
		renderStaticMap: () =>
			Effect.fail(new Error('Static maps need a provider credential in Secrets.')),
		// A real client over the host's declared file store. This used to be a stub whose every member
		// rejected, so a record sheet with a file field could take no file at all.
		createFileUploadClient: () => new WorkspaceUploadClient()
	});

	/**
	 * The principal the agent panel acts as.
	 *
	 * Built from what the host proved, never from a default. The runtime re-derives authority from
	 * the credential on every command, so this is display and panel input, not an authorization
	 * decision: `policies` stays empty because a person holds policies through their one team, and a
	 * static identity must not claim them.
	 */
	const subject = $derived({
		userId: view.user.id,
		tenantId: view.organization.id,
		teamPath: [...view.user.teamPath],
		policies: [],
		...(view.user.admin ? { admin: true } : {}),
		...(view.user.email === '' ? {} : { email: view.user.email })
	});

	/**
	 * This panel is the web agent, always, and there is nothing to resolve.
	 *
	 * It used to pick a name out of `workspace.agentNames` and then re-pick it from a
	 * `workspace.agents` round trip, because the compiler synthesized one agent per workspace and
	 * named it after the package — so the panel could not know what it was talking to without asking.
	 * The web agent has no declaration and no name of its own beyond this one; every *other* agent is
	 * an envoy, reached on a transport rather than here.
	 */
	const agentModelsQuery = $derived(workspace.frameworkClient.system.ai.models({}));

	provideAgentClient(
		untrack(() => ({
			client: workspace.frameworkClient,
			subject,
			agentName: WEB_AGENT_ID
		})),
		{
			get agentModels() {
				return agentModelsQuery;
			}
		}
	);

	/**
	 * Which of the compiled apps this session is actually allowed to see.
	 *
	 * A command rather than anything the host could have stated: the question is not "who is this" —
	 * it is "which of this workspace's apps do this subject's policies name", which needs the compiled
	 * workspace definition *and* the credential, and only `AccessControl.visibleApps` holds both.
	 *
	 * A non-administrator starts empty and stays empty if the read fails, rather than falling back to
	 * the shell's `null` ("unrestricted"). An administrator in their own operator scope is different:
	 * administration is already a host-proven status and the runtime's own `visibleApps` grants every
	 * authored app, so hiding that known set until a redundant background read finishes only paints a
	 * false empty workspace. A team preview never uses this initial set — its narrowed answer must come
	 * from the runtime before anything is shown.
	 */
	const visibleAppsQuery = $derived.by(() => {
		void accessScope;
		return workspace.frameworkClient.system.apps.visible({});
	});
	const allAuthoredAppNames = untrack(() => [
		...new Set([...Object.keys(workspace.appGroups), ...Object.keys(workspace.appLoaders)])
	]);
	const administratorInitialApps = $derived(
		view.user.admin && accessScope === 'operator' ? allAuthoredAppNames : []
	);
	const accessibleApps = $derived(visibleAppsQuery.current?.apps ?? administratorInitialApps);
	const applicationsReady = $derived(
		visibleAppsQuery.current !== undefined || (view.user.admin && accessScope === 'operator')
	);

	/**
	 * Whether this session may preview the workspace as one of its teams, and which team it is on now.
	 *
	 * Read from the runtime for the same reason `apps.visible` is: the teams are the tenant's compiled
	 * policies and "may this session impersonate" is a fact about its credential's roles, and only the
	 * bolt behind the transport holds both. `null` until it answers and `null` on failure, which is
	 * "no picker" — an administrative control that appears because a read failed is worse than one
	 * that appears a round trip late.
	 */
	const impersonationQuery = $derived.by(() => {
		// A running team preview is an authority boundary and must be resolved immediately so host
		// plugins cannot flash as available. In the ordinary operator scope this only feeds the account
		// menu, so it waits for the first real interaction instead of competing with app data reads.
		if (!accessScope.startsWith('team:') && interactiveQueriesRequestedScope !== accessScope)
			return undefined;
		return workspace.frameworkClient.system.access.impersonation({});
	});
	const impersonation = $derived(impersonationQuery?.current ?? null);

	/**
	 * The runtime accepts the preview first; only then does the host store it.
	 *
	 * That order is what makes a refusal legible: the host's record of the choice rides every later
	 * request, so storing it before the runtime had agreed would turn one refused click into every
	 * subsequent command failing, with nothing on screen saying why. It is also where the audit row is
	 * written — the per-request seam re-checks the same authority but deliberately records nothing, or
	 * a preview would append one row per request and bury the entry that says it began.
	 */
	const impersonateTeam = (teamId: string): Effect.Effect<void> =>
		workspace.frameworkClient.system.access.impersonateTeam({ teamId }).pipe(
			Effect.map(() => {
				// The host callback writes the cookie synchronously. The runtime re-derives the subject
				// from the credential on every command and the stream re-keys on policy drift, so a
				// preview narrows reads without any browser-side scope to switch.
				actions.impersonate(teamId);
			}),
			Effect.catch((cause) => Effect.logError('Impersonation was refused', cause))
		);

	const stopImpersonating = (): void => {
		actions.stopImpersonating();
	};

	/**
	 * Colony's own admin-only surfaces, hidden for as long as a preview is running.
	 *
	 * Narrowly scoped on purpose. A tenant administrator owns these pages, except while a policy
	 * preview is active. The studio is a host surface rather than a workspace app, so
	 * `accessibleApps` never reaches it and this gate must carry the real administrator status.
	 */
	const hostPluginsVisible = $derived(
		view.user.admin &&
			!accessScope.startsWith('team:') &&
			!(impersonation?.isActive ?? false)
	);

	const resolveAppName = (href: string): string | undefined => {
		if (!href.startsWith('/app/')) return undefined;
		const requested = href.slice('/app/'.length);
		if (workspace.appLoaders[requested] !== undefined) return requested;
		const defaultChild = workspace.appGroups[requested]?.defaultChild;
		if (
			defaultChild !== undefined &&
			workspace.appLoaders[`${requested}/${defaultChild}`] !== undefined
		) {
			return `${requested}/${defaultChild}`;
		}
		return Object.keys(workspace.appLoaders).find((name) => name.startsWith(`${requested}/`));
	};

	const apps = (() => {
		const names = Object.keys(workspace.appLoaders);
		const parents = new Set([
			...Object.keys(workspace.appGroups),
			...names.flatMap((name) => {
				const index = name.lastIndexOf('/');
				return index < 0 ? [] : [name.slice(0, index)];
			})
		]);
		return [
			...[...parents].map((name) => ({
				name,
				label: workspace.appGroups[name]?.label ?? humanize(name.split('/').at(-1) ?? name),
				description: workspace.appGroups[name]?.description,
				icon: workspace.appGroups[name]?.icon ?? 'lucide:layout-grid',
				defaultChild: workspace.appGroups[name]?.defaultChild
			})),
			...names.map((name) => {
				const index = name.lastIndexOf('/');
				const meta = workspace.appMeta[name];
				return {
					name,
					label: meta?.label ?? humanize(index < 0 ? name : name.slice(index + 1)),
					icon: meta?.icon ?? 'lucide:layout-grid',
					description: meta?.description,
					banner: meta?.banner,
					thumbnail: meta?.thumbnail,
					parent: index < 0 ? undefined : name.slice(0, index)
				};
			})
		];
	})();

	const path = $derived(view.path === '' ? '/' : view.path);
	const hostPlugin = $derived(hostPluginKeyFromPath(path));
	const landingName = $derived(resolveAppName(path));
	/**
	 * Which app component is mounted, and whether its module is still arriving.
	 *
	 * `component` and `loading` are the render state. The request counter is deliberately *not*
	 * reactive — it is a plain object rather than `$state` — because reading and incrementing a
	 * reactive counter from the navigation effect would make that effect subscribe to the value it
	 * writes and schedule itself forever.
	 */
	const appMount = $state({
		component: null as Component | null,
		loading: false
	});
	const appRequest = { latest: 0 };
	const App = $derived(appMount.component);

	/**
	 * Which navigation the mounted component belongs to.
	 *
	 * An app module is fetched, not held: the first visit to one costs a cold dynamic import.
	 * Assigning `appMount.component` only after that await left the *previous* app fully rendered under
	 * the new app's banner, tabs and URL for the entire wait. The old component comes down when the URL
	 * changes; the new one goes up when it arrives.
	 *
	 * The counter is the other half: two overlapping navigations resolve in import order, not click
	 * order, so a slow app could land on top of the fast one the operator actually asked for. Only
	 * the newest request is allowed to assign.
	 */
	const loadAppName = (name: string | undefined): Effect.Effect<void> => {
		const request = ++appRequest.latest;
		appMount.component = null;
		appMount.loading = false;
		const loader = name === undefined ? undefined : workspace.appLoaders[name];
		if (loader === undefined) return Effect.void;
		appMount.loading = true;
		return Effect.tryPromise(loader).pipe(
			Effect.tap((loaded) =>
				Effect.sync(() => {
					if (request === appRequest.latest) appMount.component = loaded;
				})
			),
			// A module that fails to evaluate is a missing app, never the previous one.
			Effect.catch(() =>
				Effect.sync(() => {
					if (request === appRequest.latest) appMount.component = null;
				})
			),
			Effect.ensuring(
				Effect.sync(() => {
					if (request === appRequest.latest) appMount.loading = false;
				})
			),
			Effect.asVoid
		);
	};

	/** User-triggered shell reads start only after the first interaction with a painted workspace. */
	$effect(() => {
		if (!applicationsReady || interactiveQueriesRequestedScope === accessScope) return;
		const stopListening = (): void => {
			window.removeEventListener('pointerdown', requestDeferredQueries, true);
			window.removeEventListener('keydown', requestDeferredQueries, true);
		};
		const requestDeferredQueries = (): void => {
			stopListening();
			interactiveQueriesRequestedScope = accessScope;
		};
		window.addEventListener('pointerdown', requestDeferredQueries, {
			capture: true,
			passive: true
		});
		window.addEventListener('keydown', requestDeferredQueries, { capture: true });
		return () => {
			stopListening();
		};
	});

	$effect(() => {
		const href = path;
		const name = landingName;
		const plugin = hostPlugin;
		if (plugin !== null) {
			// Same path as "no app here": it also has to invalidate a load still in flight, or that
			// module lands on top of the plugin surface when it finally resolves.
			Effect.runFork(loadAppName(undefined));
			return;
		}
		if (href.startsWith('/app/') && name !== undefined && name !== href.slice('/app/'.length)) {
			actions.navigate(`/app/${name}`, { replace: true });
			return;
		}
		Effect.runFork(loadAppName(name));
	});

	/**
	 * A policy preview can narrow the app set while an application is already mounted.
	 *
	 * Hiding its navigation entry is not enough: leaving the component mounted keeps issuing reads
	 * that the preview quite correctly refuses and lets a stale privileged surface remain on screen.
	 * Wait for the authority query to settle, then replace an inaccessible app route with the overview
	 * whose cards are already filtered to the newly visible set.
	 */
	$effect(() => {
		const visible = visibleAppsQuery.current;
		const current = landingName;
		if (visible === undefined || current === undefined || visible.apps.includes(current)) return;
		actions.navigate('/', { replace: true });
	});

	/**
	 * Removing privileged navigation is not sufficient when the page is already mounted.
	 *
	 * An administrator can begin a team preview from People, and a person's role can also change
	 * while their shell is open. In both cases the privileged component must unmount immediately;
	 * approvals deliberately remain outside this gate because approver teams are allowed there.
	 */
	$effect(() => {
		if (hostPluginsVisible) return;
		if (path === WORKSPACE_SETTINGS_PATH || path.startsWith(`${WORKSPACE_SETTINGS_PATH}/`)) {
			actions.navigate('/', { replace: true });
			return;
		}
		if (hostPlugin !== null) actions.navigate('/', { replace: true });
	});

	const memberAccessQuery = $derived(
		workspace.frameworkClient.system.identity.workspaceAccess({ tenantId: view.organization.id })
	);
</script>

<svelte:head><title>{workspace.title}</title></svelte:head>

<!--
	The workspace is a separately compiled bundle, so it owns a separate `mode-watcher` module graph
	from Colony's document shell. Language already lives inside this tree and is reactive; theme did
	not, because the sidebar mutated this bundle's store while only the host bundle had mounted the
	watcher that applies `.dark` to `<html>`. Mount the lightweight watcher here so this tree's toggle
	updates the shared document immediately. The host already owns the FOUC-prevention head script.
-->
<ModeWatcher disableHeadScriptInjection />

<BoltApp
	title={workspace.title}
	{syncStatus}
	search={view.search}
	{apps}
	{accessibleApps}
	{path}
	tenantMessages={workspace.tenantMessages}
	organization={{ id: view.organization.id, name: view.organization.name }}
	organizations={view.organizations}
	user={{
		id: view.user.id,
		name: view.user.email.split('@')[0] ?? view.user.id,
		email: view.user.email,
		// Administration is a status, so it is reported as one rather than borrowed from the role list.
		role: view.user.admin ? 'Admin' : (view.user.team ?? 'Member'),
		avatarUrl: null,
		// The path, not a `teams` array: nothing has published one since a person came to belong to
		// exactly one team, and this read a key the contract does not declare — a compile error sitting
		// in the shell that renders it, which is why the label has been empty since the cutover.
		// `teamPath` is the honest list here: their own team first, then any it inherits from.
		teamLabels: [...view.user.teamPath]
	}}
	plugins={WORKSPACE_HOST_PLUGINS}
	{impersonation}
	isAdmin={hostPluginsVisible}
	deferredQueriesReady={interactiveQueriesRequestedScope === accessScope}
	onImpersonate={impersonateTeam}
	onStopImpersonating={stopImpersonating}
	onNavigate={actions.navigate}
	onOrganizationChange={actions.changeOrganization}
	onSignOut={actions.signOut}
>
	{#if path === WORKSPACE_SETTINGS_PATH || path.startsWith(`${WORKSPACE_SETTINGS_PATH}/`)}
		<WorkspaceMembers
			access={memberAccessQuery.current ?? EMPTY_WORKSPACE_ACCESS}
			loading={memberAccessQuery.loading}
			error={memberAccessQuery.error === undefined ? undefined : String(memberAccessQuery.error)}
		/>
	{:else if hostPlugin === 'workspace-studio'}
		<StudioShell client={workspace.frameworkClient} />
	{:else if hostPlugin === 'organization'}
		<OrganizationSettings tenantId={view.organization.id} client={workspace.frameworkClient} />
	{:else if hostPlugin === 'envoys'}
		<EnvoysSettings client={workspace.frameworkClient} />
	{:else if hostPlugin === 'environment_secrets'}
		<SecretsSettings client={workspace.frameworkClient} />
	{:else if hostPlugin !== null}
		<Scroll as="section" name={hostPlugin} inset class="bg-background" aria-label={hostPlugin}>
			<Stack gap="sm">
				<h1 class="text-heading">{hostPlugin}</h1>
				<p class="max-w-2xl text-meta">This workspace declares no surface at {hostPlugin}.</p>
			</Stack>
		</Scroll>
	{:else if App}
		<App />
	{:else if appMount.loading}
		<!-- The app surface is empty because its module is still arriving, not because the app is. -->
		<p role="status" class="p-6 text-sm text-muted-foreground">Loading application…</p>
	{/if}
</BoltApp>
