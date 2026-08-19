/**
 * The pure rules behind the Studio's three tabs and its authoring tree.
 *
 * These decide what the environment selector offers, whether the tenant database is ready, which
 * release operations are legal right now, which entities the tree lists, and what the Command
 * panel can honestly claim to have measured. Keeping them out of the components is what lets the
 * chrome be asserted without mounting anything — the Studio's authoring controls are exactly where
 * a wrong answer is expensive.
 */

import { Schema } from 'effect';
import { humanize } from '@norbital-ai/std/string';
import type { CodeEditorLanguage } from '@norbital-ai/ui/code-editor';
import type { ProductIconName } from '@norbital-ai/ui/product-icon';

export type MatrixEntry = Readonly<{
	readonly tenantId: string;
	readonly environmentId: string;
	readonly releaseId: string;
	readonly artifactId: string;
	readonly health: string;
	readonly ownerEpoch: string;
}>;

export type FacilityState = Readonly<{ readonly name: string; readonly available: boolean }>;

export type UsageObservation = Readonly<{
	readonly id: string;
	readonly tenantId: string;
	readonly kind: string;
	readonly quantity: number;
}>;

export type SourceSnapshot = Readonly<{
	readonly tenantId: string;
	readonly revision: number;
	readonly files: Readonly<Record<string, string>>;
}>;

export type StudioEnvironment = Readonly<{
	readonly id: string;
	readonly label: string;
	readonly releaseId: string;
	readonly artifactId: string;
	readonly health: string;
	/** Live is the shared production runtime; it is read-only in the Studio. */
	readonly readOnly: boolean;
}>;

/**
 * Root Studio chrome, and the nested views Authoring and Review open on.
 *
 * The names are the product's own: Authoring is read as Manifest (the structured overview) or
 * Editor (the authored source); Review as the open release requests or the history behind them.
 * Both nested rails live in the shell's chrome rather than inside their panes, because they sit on
 * the same row of the page and a pane that draws its own tab strip drifts out of that row.
 */
export type StudioRootTab = 'authoring' | 'review' | 'command';
export type AuthoringView = 'manifest' | 'editor';
export type StudioReviewTab = 'requests' | 'history' | 'schema';

/**
 * One row the Editor's file tree can draw: a folder to open, or a file to load into CodeMirror.
 *
 * The host snapshot is a flat path map. This is the shaped view of that map at one directory, so
 * the tree never invents a file the snapshot does not hold and never needs a second read to expand.
 */
export type SourceTreeEntry = Readonly<{
	readonly name: string;
	readonly type: 'directory' | 'file';
	readonly path: string;
	readonly sizeBytes: number;
}>;

const compareSourceEntries = (left: SourceTreeEntry, right: SourceTreeEntry): number => {
	if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
	return left.name.localeCompare(right.name);
};

/**
 * Immediate children of `directory` (empty string is the workspace root).
 *
 * Directories come first, then files, both A–Z — the same order a VS Code explorer draws, so a
 * reader who already knows the tree does not have to re-learn it here.
 */
export const sourceTreeChildren = (
	files: ReadonlyArray<string>,
	directory = '',
	sizes: Readonly<Record<string, number>> = {}
): ReadonlyArray<SourceTreeEntry> => {
	const prefix = directory === '' ? '' : `${directory}/`;
	const seen = new Map<string, SourceTreeEntry>();
	for (const path of files) {
		if (prefix !== '' && !path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		if (rest === '') continue;
		const slash = rest.indexOf('/');
		if (slash === -1) {
			seen.set(path, { name: rest, type: 'file', path, sizeBytes: sizes[path] ?? 0 });
			continue;
		}
		const name = rest.slice(0, slash);
		const dirPath = `${prefix}${name}`;
		if (!seen.has(dirPath)) {
			seen.set(dirPath, { name, type: 'directory', path: dirPath, sizeBytes: 0 });
		}
	}
	return [...seen.values()].sort(compareSourceEntries);
};

/** Files whose path contains `query`, for the tree's filter. Empty query is no filter. */
export const sourceTreeMatches = (
	files: ReadonlyArray<string>,
	query: string,
	sizes: Readonly<Record<string, number>> = {}
): ReadonlyArray<SourceTreeEntry> => {
	const needle = query.trim().toLowerCase();
	if (needle === '') return [];
	return files
		.filter((path) => path.toLowerCase().includes(needle))
		.map((path) => ({
			name: path,
			type: 'file' as const,
			path,
			sizeBytes: sizes[path] ?? 0
		}))
		.sort((left, right) => left.path.localeCompare(right.path));
};

/**
 * The CodeMirror language the Editor can actually highlight for this path.
 *
 * The shared editor ships JavaScript, JSON, YAML, markdown and plaintext. Svelte and TS live in the
 * JS grammar because that is the highlighting the surface has, not because they are JavaScript.
 */
export const editorLanguage = (path: string): CodeEditorLanguage => {
	const file = path.split('/').pop()?.toLowerCase() ?? '';
	if (file.endsWith('.json')) return 'json';
	if (file.endsWith('.yaml') || file.endsWith('.yml')) return 'yaml';
	if (file.endsWith('.md') || file.endsWith('.mdx') || file.endsWith('.markdown')) {
		return 'markdown';
	}
	if (
		file.endsWith('.ts') ||
		file.endsWith('.mts') ||
		file.endsWith('.cts') ||
		file.endsWith('.js') ||
		file.endsWith('.mjs') ||
		file.endsWith('.cjs') ||
		file.endsWith('.tsx') ||
		file.endsWith('.jsx') ||
		file.endsWith('.svelte')
	) {
		return 'javascript';
	}
	return 'plaintext';
};

const LIVE = 'live';

/**
 * One option per routed environment, Live first.
 *
 * A tenant with no routed environment yet still gets a Live option so the selector is never empty
 * and never silently implies the workspace is unrouted when it is merely new.
 */
export const studioEnvironments = (
	entries: ReadonlyArray<MatrixEntry>
): ReadonlyArray<StudioEnvironment> => {
	const seen = new Map<string, StudioEnvironment>();
	for (const entry of entries) {
		if (seen.has(entry.environmentId)) continue;
		seen.set(entry.environmentId, {
			id: entry.environmentId,
			// Live is named as itself; anything else is a workbench identifier shown as words.
			label: entry.environmentId === LIVE ? 'Live' : humanize(entry.environmentId),
			releaseId: entry.releaseId,
			artifactId: entry.artifactId,
			health: entry.health,
			readOnly: entry.environmentId === LIVE
		});
	}
	if (seen.size === 0) {
		return [
			{
				id: LIVE,
				label: 'Live',
				releaseId: '',
				artifactId: '',
				health: 'unknown',
				readOnly: true
			}
		];
	}
	return [...seen.values()].sort((left, right) => {
		if (left.id === LIVE) return -1;
		if (right.id === LIVE) return 1;
		return left.label.localeCompare(right.label);
	});
};

/** The database badge reports the tenant's own Postgres, not the aggregate of every facility. */
export const databaseReady = (facilities: ReadonlyArray<FacilityState>): boolean =>
	facilities.find((facility) => facility.name.toLowerCase() === 'database')?.available ?? false;

/** Facilities the operator should see as missing, in the order the panel lists them. */
export const unavailableFacilities = (
	facilities: ReadonlyArray<FacilityState>
): ReadonlyArray<string> =>
	facilities.filter((facility) => !facility.available).map((facility) => facility.name);

/**
 * The one sentence the Studio says about a read-only environment, in one place.
 *
 * Colony has no operation that creates a non-live environment: `studioEnvironments` derives its
 * options from routes the gateway already resolved, and every host operation takes its
 * environment from the trusted route header. So the product's "open My workbench" instruction is
 * not actionable here, and the banner says what is true rather than pointing at a door that is
 * not there.
 */
export const LIVE_READ_ONLY_NOTICE =
	'Live is read-only. This host routes one environment per tenant, so there is no workbench to open — editing a workspace means committing to Live’s own source and building it.';

/**
 * Why the Studio never offers to open a release request.
 *
 * There is no release-request, merge-request or proposed-change entity anywhere in Colony's
 * hosting layer or Bolt's runtime. The control keeps the product's shape so the surface is not
 * quietly different from the one people know, but it can never be enabled, and this is what it
 * says when asked.
 */
export const RELEASE_REQUEST_UNAVAILABLE =
	'This host has no release-request service. Commit writes the source revision, and Build compiles and routes it.';

export type ReleaseControls = Readonly<{
	/** Writing a source revision — the host's `source` operation, guarded by the snapshot revision. */
	readonly canCommit: boolean;
	/** Compiling the committed source into an artifact and routing it — `build`. */
	readonly canBuild: boolean;
	/** Stepping the environment's deployment history back one release — `rollback`. */
	readonly canRollback: boolean;
	/** Why the controls are disabled, when they are. */
	readonly reason?: string;
}>;

/**
 * What an operator may do to this environment right now.
 *
 * Nothing is actionable while a command is in flight or the host has stopped accepting work —
 * issuing a build into a draining host is how a release ends up half-applied. Live refuses
 * authoring but still allows a rollback, because rolling back is how a bad release is undone and
 * the environment that has one is exactly the one that is live.
 */
export const releaseControls = (input: {
	readonly environment: StudioEnvironment | undefined;
	readonly busy: boolean;
	readonly accepting: boolean;
	readonly hasRelease: boolean;
}): ReleaseControls => {
	if (input.busy) {
		return {
			canCommit: false,
			canBuild: false,
			canRollback: false,
			reason: 'A command is already running.'
		};
	}
	if (!input.accepting) {
		return {
			canCommit: false,
			canBuild: false,
			canRollback: false,
			reason: 'The host is draining and is not accepting work.'
		};
	}
	if (input.environment?.readOnly === true) {
		return {
			canCommit: false,
			canBuild: false,
			canRollback: input.hasRelease,
			reason: LIVE_READ_ONLY_NOTICE
		};
	}
	return { canCommit: true, canBuild: true, canRollback: input.hasRelease };
};

/**
 * What the workspace declares, as `workspace.manifest` publishes it.
 *
 * The command filters collections by the caller's read predicate, so this is not the whole
 * workspace — it is the part this subject may see, which is exactly what the Studio should list.
 * `description` and `icon` are decoded because the projection now carries them and they are what
 * names a collection to a reader; the field extras are decoded because the Model tab is the only
 * surface that can show an enum's members or mark a searchable column.
 */
export const ManifestSchema = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	collections: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			history: Schema.Boolean,
			hooks: Schema.optionalKey(Schema.Array(Schema.String)),
			description: Schema.optionalKey(Schema.String),
			icon: Schema.optionalKey(Schema.String),
			sourcePath: Schema.optionalKey(Schema.String),
			fields: Schema.Array(
				Schema.Struct({
					name: Schema.String,
					type: Schema.String,
					required: Schema.Boolean,
					generated: Schema.Boolean,
					search: Schema.optionalKey(Schema.Boolean),
					values: Schema.optionalKey(Schema.Array(Schema.String)),
					customType: Schema.optionalKey(Schema.String)
				})
			),
			relations: Schema.Array(
				Schema.Struct({ name: Schema.String, target: Schema.String, cardinality: Schema.String })
			)
		})
	),
	apps: Schema.Array(Schema.Struct({ name: Schema.String, label: Schema.String })),
	policies: Schema.Array(Schema.Struct({ name: Schema.String, grants: Schema.Number })),
	agents: Schema.Array(Schema.Struct({ name: Schema.String })),
	automations: Schema.Array(Schema.Struct({ name: Schema.String })),
	channels: Schema.Array(Schema.Struct({ name: Schema.String })),
	integrations: Schema.Array(Schema.Struct({ name: Schema.String })),
	requiredFacilities: Schema.Array(Schema.String)
});
export type WorkspaceManifest = typeof ManifestSchema.Type;
export type ManifestCollection = WorkspaceManifest['collections'][number];

/**
 * What the workspace's `+env.ts` declares, as `secrets.status` reports it.
 *
 * Names and whether each is configured, never a value — there is deliberately no read command, so
 * this is the whole of what a browser can learn about the vault, and the Studio cannot show a
 * value even by mistake.
 */
export const EnvironmentStatusSchema = Schema.Array(
	Schema.Struct({
		name: Schema.String,
		label: Schema.String,
		description: Schema.optionalKey(Schema.String),
		secret: Schema.Boolean,
		configured: Schema.Boolean,
		default: Schema.optionalKey(Schema.String),
		updatedAt: Schema.optionalKey(Schema.String)
	})
);
export type EnvironmentVariable = (typeof EnvironmentStatusSchema.Type)[number];

/** One row under a section: the entity's name, what distinguishes it, and where it was authored. */
export type ManifestEntry = Readonly<{
	readonly name: string;
	readonly detail?: string;
	readonly sourcePath?: string;
	/** Collections carry an authored icon; every other kind takes its section's. */
	readonly icon?: string;
}>;

/** One branch of the authoring tree. The count a branch shows is `entries.length`. */
export type ManifestSection = Readonly<{
	readonly id: string;
	readonly label: string;
	/** A `product:*` reference, so a branch wears the same mark as the rest of the product. */
	readonly icon: ProductIconName;
	/** What the branch is, shown when it is selected rather than one of its members. */
	readonly summary: string;
	/**
	 * Whether the navigator opens the branch to its members.
	 *
	 * Only Collections does. Every other kind is read as a whole in its own panel, and duplicating
	 * that list into the tree gave a reader two places to click for the same page.
	 */
	readonly expandable: boolean;
	readonly entries: ReadonlyArray<ManifestEntry>;
}>;

/** Counts a noun the way an English reader expects, so no branch label reads "1 fields". */
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Every declarable kind, in a fixed order, whether or not the workspace declares any.
 *
 * A branch that disappears when its count is zero cannot say "this workspace has no automations" —
 * it says nothing, and an operator reads that as the Studio having failed to load. So the branches
 * are constant and only their counts move.
 *
 * Integrations are deliberately absent: an integration binds to one collection, so it belongs
 * under that collection's own Integrations tab rather than in a flat list beside it. Channels are
 * absent for the same reason in the other direction — a channel is how one agent is reached, so it
 * is read inside Agents rather than as a sibling branch of it. Environment is the workspace's
 * declared `+env.ts` names, which arrive from `secrets.status` rather than the manifest — the vault
 * is the only thing that knows which of them are actually set.
 */
export const manifestSections = (
	manifest: WorkspaceManifest | undefined,
	environment: ReadonlyArray<{ readonly name: string; readonly configured: boolean }> = []
): ReadonlyArray<ManifestSection> => [
	{
		id: 'collections',
		label: 'Collections',
		icon: 'collections',
		summary: 'The records this workspace stores, and everything declared around them.',
		expandable: true,
		entries: (manifest?.collections ?? []).map((collection) => {
			const hooks = collection.hooks?.length ?? 0;
			return {
				name: collection.name,
				detail: `${plural(collection.fields.length, 'field')}${hooks === 0 ? '' : ` · ${plural(hooks, 'hook')}`}`,
				...(collection.sourcePath === undefined ? {} : { sourcePath: collection.sourcePath }),
				...(collection.icon === undefined ? {} : { icon: collection.icon })
			};
		})
	},
	{
		id: 'apps',
		label: 'Apps',
		icon: 'apps',
		summary: 'The authored surfaces this workspace mounts under /app.',
		expandable: false,
		entries: (manifest?.apps ?? []).map((app) => ({
			name: app.name,
			...(app.label === '' || app.label === app.name ? {} : { detail: app.label })
		}))
	},
	{
		id: 'policies',
		label: 'Policies',
		icon: 'policies',
		summary: 'Who may read and write what. Every collection query passes through these.',
		expandable: false,
		entries: (manifest?.policies ?? []).map((policy) => ({
			name: policy.name,
			detail: plural(policy.grants, 'grant')
		}))
	},
	{
		id: 'agents',
		label: 'Agents',
		icon: 'agent',
		summary:
			'The agents this workspace declares, the channels each one is reached on, and the tools it may call.',
		expandable: false,
		entries: (manifest?.agents ?? []).map(({ name }) => ({ name }))
	},
	{
		id: 'automations',
		label: 'Automations',
		icon: 'automations',
		summary: 'Work the runtime schedules for itself, without a caller.',
		expandable: false,
		entries: (manifest?.automations ?? []).map(({ name }) => ({ name }))
	},
	{
		id: 'remotes',
		label: 'Remotes',
		icon: 'remotes',
		summary: 'Authored functions callable as invoke.<name>.',
		expandable: false,
		entries: []
	},
	{
		id: 'environment',
		label: 'Environment',
		icon: 'environment',
		summary:
			'Names the workspace declares in +env.ts. Values live in the vault and are never read here.',
		expandable: false,
		entries: environment.map((variable) => ({
			name: variable.name,
			detail: variable.configured ? 'Set' : 'Not set'
		}))
	}
];

/**
 * What `channels.status` answers, and the whole of what it answers.
 *
 * `registered` is not connectivity. It is `exists(select 1 from bolt_channel_registrations …)` —
 * whether anything ever called `channels.register` for this name — and it stays true after the
 * transport behind it dies. `received` and `replied` are cumulative receipt counts with no time
 * dimension. Decoding the shape here is what stops the surface from inventing a field the runtime
 * never sends.
 */
export const ChannelStatusSchema = Schema.Struct({
	channel: Schema.String,
	registered: Schema.Boolean,
	received: Schema.Number,
	replied: Schema.Number
});
export type ChannelStatus = typeof ChannelStatusSchema.Type;

/**
 * Why no channel row can show a green "connected" light.
 *
 * Across the whole runtime there is no command, facility tag or type that reports a channel's
 * transport state: `Communication` is `VerifyInbound`/`Send`/`Notify`/`Wake` with no probe, and
 * `channels.status` never touches it. A reachable and an unreachable channel therefore read
 * identically, and the surface says that rather than dressing `registered` up as a connection.
 */
export const CHANNEL_CONNECTION_UNREPORTABLE =
	'No command reports whether a channel’s transport is connected. `channels.status` answers with `registered` — whether the channel was ever registered with this runtime — and its receipt counts. Nothing probes the provider, so a live and a dead transport read the same here.';

/**
 * Why every channel and tool hangs off the one agent.
 *
 * The compiler synthesises exactly one agent per workspace, names it after the package, and binds
 * every declared channel to it. The binding is real, but `workspace.manifest` projects a channel as
 * a bare name, so the Studio can only present it as the agent's when the workspace has exactly one
 * agent to be unambiguous about.
 */
export const AGENT_BINDING_NOTE =
	'This runtime compiles one workspace agent and binds every declared channel to it. `workspace.manifest` projects a channel as a bare name — the authored transport, policy and task are dropped before the manifest is built — so nothing here can name the provider a channel speaks to.';

/** One tool an agent may call, and the file whose name declared it. */
export type StudioTool = Readonly<{ readonly name: string; readonly sourcePath: string }>;

/** One agent, with everything reached through it gathered underneath. */
export type StudioAgent = Readonly<{
	readonly name: string;
	readonly channels: ReadonlyArray<ManifestEntry>;
	readonly tools: ReadonlyArray<StudioTool>;
}>;

/** `src/…/+<name>.tool.ts` — the filename *is* the tool name; the compiler reads nothing else. */
const TOOL_FILE = /(?:^|\/)\+([^/]+)\.tool\.ts$/;
/** `src/channels/+<name>.channel.ts` — likewise the only part of the file that survives. */
const CHANNEL_FILE = /(?:^|\/)\+([^/]+)\.channel\.ts$/;

/**
 * The agents this workspace declares, with their channels and custom tools gathered under each.
 *
 * The manifest gives names and nothing else, so the authored source is the only place the tools are
 * legible: the compiler derives an agent's tool list from `+<name>.tool.ts` filenames and discards
 * the file's own declared description, which makes the filename the honest answer rather than a
 * lossy one. Channels attach to the single agent the compiler synthesises; a workspace that somehow
 * declares several gets them back as unattributed, because guessing which agent owns which channel
 * is exactly the kind of plausible answer nobody can check.
 */
export const workspaceAgents = (
	manifest: WorkspaceManifest | undefined,
	files: ReadonlyArray<string> = []
): ReadonlyArray<StudioAgent> => {
	const agents = manifest?.agents ?? [];
	const channelSource = new Map(
		files.flatMap((path) => {
			const name = CHANNEL_FILE.exec(path)?.[1];
			return name === undefined ? [] : [[name, path] as const];
		})
	);
	const channels: ReadonlyArray<ManifestEntry> = (manifest?.channels ?? []).map(({ name }) => {
		const sourcePath = channelSource.get(name);
		return { name, ...(sourcePath === undefined ? {} : { sourcePath }) };
	});
	const tools: ReadonlyArray<StudioTool> = files.flatMap((path) => {
		const name = TOOL_FILE.exec(path)?.[1];
		return name === undefined ? [] : [{ name, sourcePath: path }];
	});
	return agents.map(({ name }) =>
		agents.length === 1 ? { name, channels, tools } : { name, channels: [], tools: [] }
	);
};

export type StudioMetric = Readonly<{
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	/**
	 * `undefined` when the host reports no measurement.
	 *
	 * A metric nobody measured is not zero. Rendering it as `0 B` is the difference between "this
	 * tenant stores nothing" and "nothing counted", and an operator cannot tell those apart after
	 * the fact.
	 */
	readonly value: string | undefined;
	readonly detail: string;
}>;

/** Bytes in the units an operator reads them in, never more precision than the number carries. */
export const formatBytes = (bytes: number): string => {
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value = value / 1024;
		unit = unit + 1;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

const meteredQuantity = new Intl.NumberFormat('en', {
	maximumFractionDigits: 3,
	useGrouping: false
});

/**
 * The Command panel's four resource tiles, each backed by something the host actually reported.
 *
 * Host disk is the authored source the tenant is holding, which the snapshot carries in full, so
 * it is measured here rather than asked for. The database and object-storage tiles read the
 * tenant's own metered usage; a kind the meter never observed yields `undefined` rather than a
 * zero, because this host meters lazily and an unobserved tenant is not an empty one. Workbench
 * inventory is the union of the host's open sessions and the trees materialized under the tenant,
 * reported by `Workbench.inventory` — a count of zero is a tenant with no workbenches.
 */
export const studioMetrics = (input: {
	readonly usage: ReadonlyArray<UsageObservation>;
	readonly source: SourceSnapshot | undefined;
	readonly workbenches?: ReadonlyArray<{ readonly workspaceKey: string; readonly open: boolean }>;
}): ReadonlyArray<StudioMetric> => {
	/** Totals one meter kind, staying `undefined` when the meter observed the tenant not at all. */
	const metered = (kind: string): number | undefined =>
		input.usage
			.filter((observation) => observation.kind === kind)
			.reduce<number | undefined>(
				(total, observation) => (total ?? 0) + observation.quantity,
				undefined
			);
	const files = Object.values(input.source?.files ?? {});
	const sourceBytes = files.reduce((total, contents) => total + contents.length, 0);
	const database = metered('database');
	const objects = metered('files');
	const workbenches = input.workbenches ?? [];
	const open = workbenches.filter((workbench) => workbench.open).length;
	const materialized = workbenches.length - open;
	return [
		{
			id: 'host-disk',
			label: 'Tenant host disk',
			icon: 'lucide:hard-drive',
			value: input.source === undefined ? undefined : formatBytes(sourceBytes),
			detail: `Authored source at revision ${input.source?.revision ?? 0}, ${plural(files.length, 'file')}.`
		},
		{
			id: 'database',
			label: 'Database',
			icon: 'lucide:database',
			value: database === undefined ? undefined : meteredQuantity.format(database),
			detail: 'Metered database usage for this tenant. Byte-level storage is not reported.'
		},
		{
			id: 'object-storage',
			label: 'Object storage',
			icon: 'lucide:package-open',
			value: objects === undefined ? undefined : meteredQuantity.format(objects),
			detail: 'Metered file usage for this tenant. The object store reports no size.'
		},
		{
			id: 'workbenches',
			label: 'Governed workbenches',
			icon: 'lucide:boxes',
			value: String(workbenches.length),
			detail: `${plural(open, 'open session')}, ${plural(materialized, 'materialized tree')} under this tenant.`
		}
	];
};
