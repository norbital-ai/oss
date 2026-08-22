<script lang="ts">
	import { Effect } from 'effect';
	import { untrack, type Component } from 'svelte';
	import { ModeWatcher } from 'mode-watcher';
	import { humanize } from '@norbital-ai/std/string';
	import {
		setCollectionClientContext,
		setCollectionSurfaceRuntime,
		type CollectionSurface
	} from '@norbital-ai/ui/collection-runtime';
	import {
		setDataRendererRuntimeContext,
		type CustomTypeRendererMap
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
	let replicaAccessScope = $state(session.accessScope);

	/**
	 * The authored record surfaces, keyed by collection.
	 *
	 * A workspace declares what a record *is* in `+representation.svelte` — which fields belong on
	 * the sheet, in what order, through which renderer. `CollectionTable` looks for one here and falls
	 * back to the auto-emitted form.
	 *
	 * Filled in as each module resolves rather than awaited as a batch: the registry is reactive, so
	 * a sheet opened before its surface arrives renders the fallback and swaps when it lands, and one
	 * slow module cannot hold up the other twenty.
	 */
	const collectionSurfaces = $state<Record<string, CollectionSurface>>({});
	// svelte-ignore state_referenced_locally -- loader identity is fixed for this compiled mount; rerunning on host view updates would duplicate module loads.
	for (const [collection, load] of Object.entries(workspace.representationLoaders)) {
		void Effect.runPromise(
			Effect.tryPromise(load).pipe(
				Effect.tap((representation) =>
					Effect.sync(() => (collectionSurfaces[collection] = { representation }))
				),
				Effect.catch(() => Effect.void)
			)
		);
	}
	setCollectionSurfaceRuntime({
		appId: () => landingName ?? '',
		surfaces: collectionSurfaces,
		claimView: () => () => undefined
	});

	/**
	 * The workspace's own collection client, published for surfaces that have no table above them.
	 *
	 * A record sheet used to be rendered by whichever `CollectionTable` had registered it on mount,
	 * which meant a `?stack=` frame naming a table on an unopened tab had nothing to render with. The
	 * sheet now reads the record itself, and this is where it gets the client to read it through —
	 * the same compiled client Studio's Data tab uses, from the bundle, never from a host lookup.
	 *
	 * The generated client is typed with the complete collection capability, including records,
	 * history and approvals, so the context receives it directly without a second runtime guard.
	 */
	// svelte-ignore state_referenced_locally -- the compiled workspace is fixed for this mount.
	setCollectionClientContext(() => workspace.client);

	/**
	 * A custom type's own renderer, keyed by the type name its columns declare.
	 *
	 * `custom('leave_event')` is a jsonb column whose shape only its author knows, so the type ships
	 * the component that reads it. Without these every custom field falls through to the JSON dump.
	 */
	const customTypeRenderers = $state<Record<string, CustomTypeRendererMap[string]>>({});
	// svelte-ignore state_referenced_locally -- custom renderer modules belong to this fixed compiled mount and load exactly once.
	for (const [typeName, load] of Object.entries(workspace.customTypeRendererLoaders)) {
		void Effect.runPromise(
			Effect.tryPromise(load).pipe(
				Effect.tap((renderer) => Effect.sync(() => (customTypeRenderers[typeName] = renderer))),
				Effect.catch(() => Effect.void)
			)
		);
	}

	setDataRendererRuntimeContext({
		customTypeRenderers,
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
	 * The subject the local replica reasons about.
	 *
	 * Built from what the host proved, never from a default. `policyNames` is unioned in for the local
	 * replica alone, and only for a non-administrator: an administrator's authority is the status,
	 * which the replica's own access control short-circuits on, so widening their roles as well would
	 * conflate the two again.
	 */
	const subject = $derived({
		userId: view.user.id,
		tenantId: view.organization.id,
		teamPath: [...view.user.teamPath],
		// Empty, and empty for a person always: a person holds policies through their one team, and
		// this array is what a *static* identity carries. It is a `MINTED_IDENTITY` field, so the
		// boundary would refuse a payload that claimed one anyway — sending `[]` is the honest shape
		// rather than a claim the server has to strip.
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
	const agentModelsQuery = $derived(workspace.client.system.ai.models({}));

	provideAgentClient(
		untrack(() => ({
			client: workspace.client,
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
	 * It starts empty and stays empty if the read fails, rather than falling back to the shell's
	 * `null` ("unrestricted"). Failing open would mean one dropped request restores exactly the
	 * disclosure this closes. The runtime remains the authority either way — this gates what the
	 * workspace offers, never what it will serve.
	 */
	const visibleAppsQuery = $derived.by(() => {
		void replicaAccessScope;
		return workspace.client.system.apps.visible({});
	});
	const accessibleApps = $derived(visibleAppsQuery.current?.apps ?? []);

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
		void replicaAccessScope;
		return workspace.client.system.access.impersonation({});
	});
	const impersonation = $derived(impersonationQuery.current ?? null);

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
		Effect.gen(function* () {
			yield* workspace.client.system.access.impersonateTeam({ teamId });
			// The host callback writes the cookie synchronously. Switch the browser caches immediately
			// so no reader can observe rows held under the previous policy scope.
			actions.impersonate(teamId);
			const nextScope = `team:${teamId}`;
			workspace.changeAccessScope(nextScope);
			replicaAccessScope = nextScope;
		}).pipe(Effect.catch((cause) => Effect.logError('Impersonation was refused', cause)));

	const stopImpersonating = (): void => {
		actions.stopImpersonating();
		workspace.changeAccessScope('operator');
		replicaAccessScope = 'operator';
	};

	/**
	 * Colony's own admin-only surfaces, hidden for as long as a preview is running.
	 *
	 * Narrowly scoped on purpose. Outside a preview this stays `true`. But leaving "Workspace Studio"
	 * in the sidebar while the workspace is being shown as an employee contradicts the one thing the
	 * preview claims, and the studio is a host surface rather than a workspace app, so
	 * `accessibleApps` never reached it.
	 */
	const hostPluginsVisible = $derived(!(impersonation?.isActive ?? false));

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
	 * One cell because the three fields move together: the request counter is what tells a late module
	 * that the navigation it belongs to was already superseded, and `component`/`loading` are what the
	 * shell renders while that is decided.
	 */
	const appMount = $state({
		component: null as Component | null,
		loading: false,
		request: 0
	});
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
	const loadAppName = (name: string | undefined): Promise<void> => {
		const request = ++appMount.request;
		appMount.component = null;
		appMount.loading = false;
		const loader = name === undefined ? undefined : workspace.appLoaders[name];
		if (loader === undefined) return Effect.runPromise(Effect.void);
		appMount.loading = true;
		return Effect.runPromise(
			Effect.tryPromise(loader).pipe(
				Effect.tap((loaded) =>
					Effect.sync(() => {
						if (request === appMount.request) appMount.component = loaded;
					})
				),
				// A module that fails to evaluate is a missing app, never the previous one.
				Effect.catch(() =>
					Effect.sync(() => {
						if (request === appMount.request) appMount.component = null;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						if (request === appMount.request) appMount.loading = false;
					})
				),
				Effect.asVoid
			)
		);
	};

	/**
	 * Starts the local replica, which is what makes a second visit cheap.
	 *
	 * Deliberately late and deliberately optional. Failures are swallowed on purpose: a browser
	 * without wasm, without IndexedDB, or in a private window that refuses persistence must keep
	 * working over the wire — degraded to exactly what it had before any of this existed, never
	 * broken. There is no fallback path to write because the fallback *is* the ordinary path.
	 *
	 * The returned teardown matters: starting the replica opens the change subscription, and a shell
	 * that unmounted without stopping it would leave a stream per mount holding a host connection
	 * open.
	 */
	$effect(() => {
		const accessScope = replicaAccessScope;
		let stop: (() => void) | undefined;
		let unmounted = false;
		void Effect.runPromise(
			Effect.tryPromise(() => workspace.startLocalReplica(accessScope)).pipe(
				Effect.tap((replica) =>
					Effect.sync(() => {
						// Resolved after teardown — stop it now rather than leaking its stream.
						if (unmounted) replica.stop();
						else stop = replica.stop;
					})
				),
				Effect.catch(() => Effect.void)
			)
		);
		return () => {
			unmounted = true;
			stop?.();
		};
	});

	$effect(() => {
		const href = path;
		const name = landingName;
		const plugin = hostPlugin;
		if (plugin !== null) {
			// Same path as "no app here": it also has to invalidate a load still in flight, or that
			// module lands on top of the plugin surface when it finally resolves.
			void loadAppName(undefined);
			return;
		}
		if (href.startsWith('/app/') && name !== undefined && name !== href.slice('/app/'.length)) {
			actions.navigate(`/app/${name}`, { replace: true });
			return;
		}
		void loadAppName(name);
	});

	const memberAccessQuery = $derived(
		workspace.client.system.identity.workspaceAccess({ tenantId: view.organization.id })
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
		<StudioShell client={workspace.client} />
	{:else if hostPlugin === 'organization'}
		<OrganizationSettings tenantId={view.organization.id} client={workspace.client} />
	{:else if hostPlugin === 'envoys'}
		<EnvoysSettings client={workspace.client} />
	{:else if hostPlugin === 'environment_secrets'}
		<SecretsSettings client={workspace.client} />
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
