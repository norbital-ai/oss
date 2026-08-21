<script lang="ts">
	import type { Component } from 'svelte';
	import { ModeWatcher } from 'mode-watcher';
	import {
		resolveCollectionClient,
		setCollectionClientContext,
		setCollectionSurfaceRuntime,
		type CollectionSurface
	} from '@norbital-ai/ui/collection-runtime';
	import {
		setDataRendererRuntimeContext,
		type CustomTypeRendererMap
	} from '@norbital-ai/ui/data-renderer';
	import type { WorkspaceImpersonation } from '@norbital-ai/ui/workspace-shell';
	import BoltApp from './app.svelte';
	import { Scroll, Stack } from '@norbital-ai/ui/layout';
	import {
		WORKSPACE_HOST_PLUGINS,
		WORKSPACE_SETTINGS_PATH,
		hostPluginKeyFromPath
	} from './workspace-navigation.js';
	import WorkspaceMembers from '../settings/workspace.svelte';
	import { EMPTY_WORKSPACE_ACCESS, type WorkspaceAccess } from '../settings/access.js';
	import AgentsSettings from '../org/agents-settings.svelte';
	import OrganizationSettings from '../org/organization-settings.svelte';
	import SecretsSettings from '../org/secrets-settings.svelte';
	import StudioShell from '../studio/studio-shell.svelte';
	import { configureAgentRuntime } from '../agent/client.js';
	import { resolveWorkspaceAgentName } from '../agent/agent-name.js';
	import { setWorkspaceRemoteTransport } from '../agent/remote-transport.js';
	import { WorkspaceUploadClient } from '../state/file-upload-client.svelte.js';
	import { workspaceSession } from '../../session.js';
	import type {
		CompiledWorkspace,
		WorkspaceHostActions,
		WorkspaceView
	} from './workspace-contract.js';

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
	for (const [collection, load] of Object.entries(workspace.representationLoaders)) {
		void load()
			.then((module) => {
				const representation = module as CollectionSurface['representation'];
				if (representation !== undefined) collectionSurfaces[collection] = { representation };
			})
			.catch(() => undefined);
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
	 * Duck-checked rather than cast: `WorkspaceClient` under-declares what the generated runtime
	 * actually carries (`records`, `history`, `approvals`), and this is the seam that verifies it.
	 */
	// svelte-ignore state_referenced_locally -- the compiled workspace is fixed for this mount.
	const collectionClient = resolveCollectionClient(workspace.client);
	if (collectionClient) setCollectionClientContext(() => collectionClient);

	/**
	 * A custom type's own renderer, keyed by the type name its columns declare.
	 *
	 * `custom('leave_event')` is a jsonb column whose shape only its author knows, so the type ships
	 * the component that reads it. Without these every custom field falls through to the JSON dump.
	 */
	const customTypeRenderers = $state<Record<string, CustomTypeRendererMap[string]>>({});
	for (const [typeName, load] of Object.entries(workspace.customTypeRendererLoaders)) {
		void load()
			.then((module) => {
				const renderer = module as CustomTypeRendererMap[string];
				if (renderer !== undefined) customTypeRenderers[typeName] = renderer;
			})
			.catch(() => undefined);
	}

	setDataRendererRuntimeContext({
		customTypeRenderers,
		// These two need a provider credential the host does not hold yet — they belong to the Secrets
		// vault. Refusing names what is missing; returning an empty result would render an address
		// picker that silently finds nothing and a map that is silently blank.
		autocompleteGeolocation: () =>
			Promise.reject(new Error('Geolocation autocomplete needs a provider credential in Secrets.')),
		renderStaticMap: () =>
			Promise.reject(new Error('Static maps need a provider credential in Secrets.')),
		// A real client over the host's declared file store. This used to be a stub whose every member
		// rejected, so a record sheet with a file field could take no file at all.
		createFileUploadClient: () => new WorkspaceUploadClient()
	});

	const FALLBACK_DEFAULT_MODEL = 'deepseek/deepseek-v4-flash-0731';

	const isModelCatalog = (
		value: unknown
	): value is {
		defaultModel: string;
		options: ReadonlyArray<{ id: string; label: string; contextLength?: number }>;
	} => {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
		const defaultModel = Reflect.get(value, 'defaultModel');
		const options = Reflect.get(value, 'options');
		return (
			typeof defaultModel === 'string' &&
			Array.isArray(options) &&
			options.every((option) => {
				if (option === null || typeof option !== 'object' || Array.isArray(option)) return false;
				const id = Reflect.get(option, 'id');
				const label = Reflect.get(option, 'label');
				const contextLength = Reflect.get(option, 'contextLength');
				return (
					typeof id === 'string' &&
					typeof label === 'string' &&
					(contextLength === undefined || typeof contextLength === 'number')
				);
			})
		);
	};

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
		...(view.user.team === undefined ? {} : { team: view.user.team }),
		teamPath: [...view.user.teamPath],
		...(view.user.admin ? { admin: true } : {}),
		...(view.user.email === '' ? {} : { email: view.user.email })
	});

	const configureResolvedAgent = (names: ReadonlyArray<string>, selected?: string): void => {
		const agentName = resolveWorkspaceAgentName(names, selected);
		if (agentName === undefined) return;
		configureAgentRuntime({
			transport: session.transport,
			subject,
			agentName,
			userId: subject.userId
		});
	};
	configureResolvedAgent(workspace.agentNames);
	void session.transport
		.command('workspace.agents', {})
		.then((value) => {
			if (!Array.isArray(value)) return;
			const names = value.filter(
				(entry): entry is string => typeof entry === 'string' && entry.length > 0
			);
			configureResolvedAgent(names, resolveWorkspaceAgentName(workspace.agentNames));
		})
		.catch(() => undefined);
	setWorkspaceRemoteTransport({
		// Host catalog is optional until Identity publishes one; a missing command and an invalid
		// response shape both fall back to the same default catalog.
		agentModels: async () => {
			const catalog = await session.transport.command('ai.models', {}).catch(() => undefined);
			return isModelCatalog(catalog)
				? catalog
				: { defaultModel: FALLBACK_DEFAULT_MODEL, options: [] };
		}
	});

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
	let accessibleApps = $state<ReadonlyArray<string>>([]);

	const readVisibleApps = (payload: unknown): ReadonlyArray<string> => {
		// An unreadable shape is not a permissive one: anything but an array of names reads as "no
		// apps", so a changed projection cannot silently widen the sidebar back to the whole registry.
		const listed =
			typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'apps') : undefined;
		return Array.isArray(listed)
			? listed.filter((entry): entry is string => typeof entry === 'string')
			: [];
	};

	void session.transport
		.command('apps.visible', {})
		.then((payload) => {
			accessibleApps = readVisibleApps(payload);
		})
		.catch(() => undefined);

	/**
	 * Whether this session may preview the workspace as one of its teams, and which team it is on now.
	 *
	 * Read from the runtime for the same reason `apps.visible` is: the teams are the tenant's compiled
	 * policies and "may this session impersonate" is a fact about its credential's roles, and only the
	 * bolt behind the transport holds both. `null` until it answers and `null` on failure, which is
	 * "no picker" — an administrative control that appears because a read failed is worse than one
	 * that appears a round trip late.
	 */
	let impersonation = $state<WorkspaceImpersonation | null>(null);
	let replicaAccessScope = $state(session.accessScope);

	const readImpersonation = (payload: unknown): WorkspaceImpersonation | null => {
		if (typeof payload !== 'object' || payload === null) return null;
		const teams = Reflect.get(payload, 'teams');
		const activeTeamIds = Reflect.get(payload, 'activeTeamIds');
		return {
			isAdmin: Reflect.get(payload, 'isAdmin') === true,
			isActive: Reflect.get(payload, 'isActive') === true,
			activeTeamIds: Array.isArray(activeTeamIds)
				? activeTeamIds.filter((entry): entry is string => typeof entry === 'string')
				: [],
			teams: Array.isArray(teams)
				? teams.flatMap((entry: unknown) => {
						if (typeof entry !== 'object' || entry === null) return [];
						const id = Reflect.get(entry, 'id');
						const name = Reflect.get(entry, 'name');
						return typeof id === 'string' && id.length > 0
							? [{ id, name: typeof name === 'string' ? name : null }]
							: [];
					})
				: []
		};
	};

	const loadImpersonation = (): void => {
		void session.transport
			.command('access.impersonation', {})
			.then((payload) => {
				impersonation = readImpersonation(payload);
			})
			.catch(() => {
				impersonation = null;
			});
	};
	loadImpersonation();

	/**
	 * The runtime accepts the preview first; only then does the host store it.
	 *
	 * That order is what makes a refusal legible: the host's record of the choice rides every later
	 * request, so storing it before the runtime had agreed would turn one refused click into every
	 * subsequent command failing, with nothing on screen saying why. It is also where the audit row is
	 * written — the per-request seam re-checks the same authority but deliberately records nothing, or
	 * a preview would append one row per request and bury the entry that says it began.
	 */
	const impersonateTeam = async (teamId: string): Promise<void> => {
		let response: unknown;
		try {
			response = await session.transport.command('access.impersonateTeam', { teamId });
		} catch (cause) {
			// Swallowing it would leave a picker that appears to have selected a team the runtime never
			// granted. Re-reading the state snaps the control back to what is actually in force.
			console.error('Impersonation was refused', cause);
			loadImpersonation();
			return;
		}
		// The host callback writes the cookie synchronously. Switch the browser caches immediately after
		// it, in the same turn, so refreshed queries carry the new preview while the previous replica is
		// already unavailable to readers.
		actions.impersonate(teamId);
		const nextScope = `team:${teamId}`;
		workspace.changeAccessScope(nextScope);
		replicaAccessScope = nextScope;
		accessibleApps = readVisibleApps(response);
		if (impersonation !== null) {
			impersonation = {
				...impersonation,
				isActive: true,
				activeTeamIds: [teamId]
			};
		}
	};

	const stopImpersonating = (): void => {
		actions.stopImpersonating();
		workspace.changeAccessScope('operator');
		replicaAccessScope = 'operator';
		accessibleApps = [];
		if (impersonation !== null) {
			impersonation = { ...impersonation, isActive: false, activeTeamIds: [] };
		}
		// The visual mode changes immediately; these two reads repopulate the administrator's app list
		// and reconcile the picker without remounting the workspace or waiting on a document navigation.
		void session.transport
			.command('apps.visible', {})
			.then((payload) => {
				accessibleApps = readVisibleApps(payload);
			})
			.catch(() => undefined);
		loadImpersonation();
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

	const humanize = (value: string): string =>
		value.replaceAll(/[-_]/g, ' ').replaceAll(/\b\w/g, (character) => character.toUpperCase());

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
				...(workspace.appGroups[name]?.description === undefined
					? {}
					: { description: workspace.appGroups[name].description }),
				icon: workspace.appGroups[name]?.icon ?? 'lucide:layout-grid',
				...(workspace.appGroups[name]?.defaultChild === undefined
					? {}
					: { defaultChild: workspace.appGroups[name].defaultChild })
			})),
			...names.map((name) => {
				const index = name.lastIndexOf('/');
				const meta = workspace.appMeta[name];
				return {
					name,
					label: meta?.label ?? humanize(index < 0 ? name : name.slice(index + 1)),
					icon: meta?.icon ?? 'lucide:layout-grid',
					...(meta?.description === undefined ? {} : { description: meta.description }),
					...(meta?.banner === undefined ? {} : { banner: meta.banner }),
					...(meta?.thumbnail === undefined ? {} : { thumbnail: meta.thumbnail }),
					...(index < 0 ? {} : { parent: name.slice(0, index) })
				};
			})
		];
	})();

	const path = $derived(view.path === '' ? '/' : view.path);
	const hostPlugin = $derived(hostPluginKeyFromPath(path));
	const landingName = $derived(resolveAppName(path));
	let App = $state<Component | null>(null);
	let appLoading = $state(false);

	/**
	 * Which navigation the mounted component belongs to.
	 *
	 * An app module is fetched, not held: the first visit to one costs a cold dynamic import.
	 * Assigning `App` only after that await left the *previous* app fully rendered under the new
	 * app's banner, tabs and URL for the entire wait. The old component comes down when the URL
	 * changes; the new one goes up when it arrives.
	 *
	 * The counter is the other half: two overlapping navigations resolve in import order, not click
	 * order, so a slow app could land on top of the fast one the operator actually asked for. Only
	 * the newest request is allowed to assign.
	 */
	let requestedApp = 0;

	const loadAppName = async (name: string | undefined): Promise<void> => {
		const request = ++requestedApp;
		App = null;
		appLoading = false;
		const loader = name === undefined ? undefined : workspace.appLoaders[name];
		if (loader === undefined) return;
		appLoading = true;
		try {
			const loaded = await loader();
			if (request !== requestedApp) return;
			// The generated registry types app loaders as returning `unknown`; a Svelte component is a
			// function at runtime, and this boundary is where that is asserted once.
			App = typeof loaded === 'function' ? (loaded as Component) : null;
		} catch {
			// A module that fails to evaluate is a missing app, not the previous one. Swallowing this
			// silently is what left a broken import rendering the app the operator had just left.
			if (request !== requestedApp) return;
			App = null;
		} finally {
			if (request === requestedApp) appLoading = false;
		}
	};

	// Read once per mount; membership does not change under the user mid-session.
	$effect(() => {
		void loadWorkspaceAccess();
	});

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
		void workspace
			.startLocalReplica(accessScope)
			.then((replica) => {
				// Resolved after teardown — stop it now rather than leaking the stream it just opened.
				if (unmounted) replica.stop();
				else stop = replica.stop;
			})
			.catch(() => undefined);
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

	type MemberRole = 'admin' | 'manager' | 'basic';
	let workspaceAccess = $state<WorkspaceAccess>(EMPTY_WORKSPACE_ACCESS);
	let accessLoading = $state(true);
	let accessError = $state<string | undefined>(undefined);

	/**
	 * The wire carries role and status as open strings; the settings surfaces are typed on closed
	 * sets. Deciding what an unrecognised value means belongs here, at the boundary, rather than
	 * being asserted past — an unknown role reads as the least privileged one.
	 */
	const asMemberRole = (value: unknown): MemberRole =>
		value === 'admin' || value === 'manager' ? value : 'basic';
	const text = (row: unknown, field: string): string =>
		typeof row === 'object' && row !== null && typeof Reflect.get(row, field) === 'string'
			? (Reflect.get(row, field) as string)
			: '';
	const optionalText = (row: unknown, field: string): string | undefined => {
		const value = text(row, field);
		return value === '' ? undefined : value;
	};

	const decodeAccess = (payload: unknown): WorkspaceAccess => {
		if (typeof payload !== 'object' || payload === null) return EMPTY_WORKSPACE_ACCESS;
		const list = (field: string): ReadonlyArray<unknown> => {
			const value = Reflect.get(payload, field);
			return Array.isArray(value) ? value : [];
		};
		return {
			members: list('members').map((row) => ({
				id: text(row, 'id'),
				email: text(row, 'email'),
				name: text(row, 'name'),
				role: asMemberRole(
					typeof row === 'object' && row !== null ? Reflect.get(row, 'role') : undefined
				),
				status: (() => {
					const raw =
						typeof row === 'object' && row !== null ? Reflect.get(row, 'status') : undefined;
					return raw === 'suspended' || raw === 'invited' ? raw : 'active';
				})(),
				// `team`, singular, because that is the key the projection publishes — a person belongs
				// to exactly one team. This read `teams` and filtered an array that is never on the
				// wire, so every member rendered as belonging to nothing at all.
				...(optionalText(row, 'team') === undefined ? {} : { team: text(row, 'team') })
			})),
			invitations: list('invitations').map((row) => ({
				id: text(row, 'id'),
				email: text(row, 'email'),
				role: asMemberRole(
					typeof row === 'object' && row !== null ? Reflect.get(row, 'role') : undefined
				),
				status: (() => {
					const raw =
						typeof row === 'object' && row !== null ? Reflect.get(row, 'status') : undefined;
					return raw === 'accepted' || raw === 'revoked' || raw === 'expired' ? raw : 'pending';
				})(),
				...(optionalText(row, 'invitedBy') === undefined
					? {}
					: { invitedBy: text(row, 'invitedBy') }),
				...(optionalText(row, 'expiresAt') === undefined
					? {}
					: { expiresAt: text(row, 'expiresAt') })
			})),
			// `parentId` and `description` are carried rather than dropped: the projection reads all four
			// columns off `bolt_team`, and the chart below is a *hierarchy* — decoding the id and the
			// name alone drew every team as a root and threw the nesting away between the wire and the
			// component that exists to show it.
			teams: list('teams').map((row) => ({
				id: text(row, 'id'),
				name: text(row, 'name'),
				...(optionalText(row, 'parentId') === undefined ? {} : { parentId: text(row, 'parentId') }),
				...(optionalText(row, 'description') === undefined
					? {}
					: { description: text(row, 'description') })
			})),
			events: list('events').map((row) => ({
				id: text(row, 'id'),
				action: text(row, 'action'),
				actor: text(row, 'actor'),
				...(optionalText(row, 'subject') === undefined ? {} : { subject: text(row, 'subject') }),
				at: text(row, 'at')
			}))
		};
	};

	/**
	 * Workspace membership is tenant state, so the tenant runtime is what answers for it.
	 *
	 * Over the session's transport, like every other read here. This used to be its own `fetch` to a
	 * literal host path with its own `Authorization` header — a fifth HTTP client, and the only one
	 * that could disagree with the rest about where a command goes.
	 */
	const loadWorkspaceAccess = async (): Promise<void> => {
		accessLoading = true;
		accessError = undefined;
		try {
			workspaceAccess = decodeAccess(
				await session.transport.command('identity.workspaceAccess', {
					tenantId: view.organization.id
				})
			);
		} catch (cause) {
			// Surfaced on the People surface rather than swallowed: a silent empty read renders as a
			// working workspace with nobody in it, which is how an empty people page is born.
			accessError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			accessLoading = false;
		}
	};
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
		<WorkspaceMembers access={workspaceAccess} loading={accessLoading} error={accessError} />
	{:else if hostPlugin === 'workspace-studio'}
		<StudioShell client={workspace.client} />
	{:else if hostPlugin === 'organization'}
		<OrganizationSettings tenantId={view.organization.id} />
	{:else if hostPlugin === 'agent'}
		<AgentsSettings />
	{:else if hostPlugin === 'environment_secrets'}
		<SecretsSettings />
	{:else if hostPlugin !== null}
		<Scroll as="section" name={hostPlugin} inset class="bg-background" aria-label={hostPlugin}>
			<Stack gap="sm">
				<h1 class="text-heading">{hostPlugin}</h1>
				<p class="max-w-2xl text-meta">This workspace declares no surface at {hostPlugin}.</p>
			</Stack>
		</Scroll>
	{:else if App}
		<App />
	{:else if appLoading}
		<!-- The app surface is empty because its module is still arriving, not because the app is. -->
		<p role="status" class="p-6 text-sm text-muted-foreground">Loading application…</p>
	{/if}
</BoltApp>
