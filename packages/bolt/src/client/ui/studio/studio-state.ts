/**
 * The pure rules behind Studio's Workbench, Review, and administrator Operations surfaces.
 *
 * These decide what the environment selector offers, whether the tenant database is ready, which
 * release operations are legal right now, which entities the tree lists, and what Operations can
 * honestly claim to have measured. Keeping them out of the components is what lets the
 * chrome be asserted without mounting anything — Studio's workbench controls are exactly where
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
	readonly workspaceKey: string;
	readonly baseCommit: string;
	readonly commit: string;
	readonly files: Readonly<Record<string, string>>;
}>;

type SourceFileChange = Readonly<{
	readonly path: string;
	readonly before: string | null;
	readonly after: string;
}>;

export type SourceCommit = Readonly<{
	readonly commit: string;
	readonly parent: string;
	readonly changes: ReadonlyArray<SourceFileChange>;
}>;

type ReleaseSchemaPlan = Readonly<{
	readonly fingerprint: string;
	readonly steps: ReadonlyArray<Readonly<{ readonly id: string; readonly sql: string }>>;
}>;

type ReleaseRequestStatus = 'open' | 'approving' | 'approved' | 'changes_requested' | 'rejected';

export type ReleaseRequest = Readonly<{
	readonly id: string;
	readonly tenantId: string;
	readonly environmentId: string;
	readonly workspaceKey: string;
	readonly authorId: string;
	readonly commit: string;
	readonly baseCommit: string;
	readonly previewEnvironmentId: string;
	readonly baseReleaseId: string | null;
	readonly releaseId: string;
	readonly artifactId: string;
	readonly checksum: string;
	readonly schemaPlan: ReleaseSchemaPlan;
	readonly status: ReleaseRequestStatus;
	readonly reason: string | null;
	readonly changedFiles: ReadonlyArray<SourceFileChange>;
}>;

type StudioEnvironment = Readonly<{
	readonly id: string;
	readonly label: string;
	readonly releaseId: string;
	readonly artifactId: string;
	readonly health: string;
	/** Live is the shared production runtime; it is read-only in the Studio. */
	readonly readOnly: boolean;
}>;

/**
 * Root Studio chrome, and the nested views Workbench and Review open on.
 *
 * Workbench is read as Manifest (the structured overview) or
 * Editor (the authored source); Review as the open release requests or the history behind them.
 * Both nested rails live in the shell's chrome rather than inside their panes, because they sit on
 * the same row of the page and a pane that draws its own tab strip drifts out of that row.
 */
export type StudioRootTab = 'workbench' | 'review' | 'operations';
export type WorkbenchView = 'manifest' | 'editor';
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
	// One pass: the filter runs on every keystroke over the whole source tree, so matching and
	// projecting together avoids walking it twice before the sort walks it again.
	const matches: Array<SourceTreeEntry> = [];
	for (const path of files) {
		if (!path.toLowerCase().includes(needle)) continue;
		matches.push({ name: path, type: 'file' as const, path, sizeBytes: sizes[path] ?? 0 });
	}
	return matches.sort((left, right) => left.path.localeCompare(right.path));
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
 * The routed release Operations summarizes above the full tenant matrix.
 *
 * `live` is a conventional environment name, not a protocol value. Colony's configured environment
 * is `development` by default, so requiring the literal name made a successfully built tenant read as
 * "No live release" while the matrix immediately below showed its release and artifact. Prefer Live
 * when a host exposes it, then fall back to the first release the host actually routed.
 */
export const currentRoutedRelease = (
	entries: ReadonlyArray<MatrixEntry>
): MatrixEntry | undefined => {
	const routed = entries.filter((entry) => entry.releaseId !== '');
	return routed.find((entry) => entry.environmentId === LIVE) ?? routed[0];
};

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
export type ReleaseControls = Readonly<{
	/** Generating DDL, checking, bundling, and provisioning this personal workbench commit. */
	readonly canPreview: boolean;
	/** Sending the exact built Preview into Review. */
	readonly canRequestReview: boolean;
	/** Stepping the environment's deployment history back one release — `rollback`. */
	readonly canRollback: boolean;
	/** Why the controls are disabled, when they are. */
	readonly reason?: string;
}>;

type ReleaseControlInput = Readonly<{
	readonly busy: boolean;
	readonly accepting: boolean;
	readonly hasRelease: boolean;
}>;

/**
 * What an operator may do to this environment right now.
 *
 * Nothing is actionable while a command is in flight or the host has stopped accepting work —
 * issuing a build into a draining host is how a release ends up half-applied. Live refuses
 * authoring but still allows a rollback, because rolling back is how a bad release is undone and
 * the environment that has one is exactly the one that is live.
 */
export const releaseControls = (input: ReleaseControlInput): ReleaseControls => {
	if (input.busy) {
		return {
			canPreview: false,
			canRequestReview: false,
			canRollback: false,
			reason: 'A command is already running.'
		};
	}
	if (!input.accepting) {
		return {
			canPreview: false,
			canRequestReview: false,
			canRollback: false,
			reason: 'The host is draining and is not accepting work.'
		};
	}
	return { canPreview: true, canRequestReview: true, canRollback: input.hasRelease };
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
	automations: Schema.Array(Schema.Struct({ name: Schema.String })),
	/**
	 * Every envoy, with what it is and where it is reached — not a bare name.
	 *
	 * The manifest used to project a channel as `{ name }` alone, so nothing downstream could say
	 * which transport it spoke to or who could reach it, and the Studio had to write a paragraph
	 * explaining that it could not know. It carries `transport` and `audience` now, so it can.
	 */
	envoys: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			transport: Schema.String,
			audience: Schema.String
		})
	),
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
type ManifestEntry = Readonly<{
	readonly name: string;
	readonly detail?: string;
	readonly sourcePath?: string | undefined;
	/** Collections carry an authored icon; every other kind takes its section's. */
	readonly icon?: string | undefined;
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
 * under that collection's own Integrations tab rather than in a flat list beside it. Environment is
 * the workspace's
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
				sourcePath: collection.sourcePath,
				icon: collection.icon
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
		id: 'envoys',
		label: 'Envoys',
		icon: 'agent',
		summary: 'The agents this workspace exposes on a transport, and what each one is reached on.',
		expandable: false,
		entries: (manifest?.envoys ?? []).map(({ name, transport, audience }) => ({
			name,
			detail: `${transport} · ${audience}`
		}))
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
 * What `envoys.status` answers, and the whole of what it answers.
 *
 * `registered` is not connectivity. It is `exists(select 1 from bolt_envoy_registrations …)` —
 * whether anything ever called `envoys.register` for this name — and it stays true after the
 * transport behind it dies. `received` and `replied` are cumulative receipt counts with no time
 * dimension. Decoding the shape here is what stops the surface from inventing a field the runtime
 * never sends.
 */
export const EnvoyStatusSchema = Schema.Struct({
	envoy: Schema.String,
	registered: Schema.Boolean,
	received: Schema.Number,
	replied: Schema.Number
});

/**
 * Why no envoy row can show a green "connected" light *from the runtime*.
 *
 * Across the whole runtime there is no command, facility tag or type that reports a transport's
 * state: `Communication` is `VerifyInbound`/`Send`/`Notify`/`Wake` with no probe, and
 * `envoys.status` never touches it. A reachable and an unreachable envoy therefore read identically
 * here, and the surface says that rather than dressing `registered` up as a connection. The host
 * *does* know — it holds the socket — and the Envoys settings page asks it; that answer is host
 * state and deliberately does not come back into the tenant.
 */
export const ENVOY_CONNECTION_UNREPORTABLE =
	'No runtime command reports whether an envoy’s transport is connected. `envoys.status` answers with `registered` — whether the envoy was ever registered with this runtime — and its receipt counts. Nothing here probes the provider, so a live and a dead transport read the same; the host holds the socket and answers that question on the Envoys settings page.';

/** One tool a policy may grant, and the file whose name declared it. */
export type StudioTool = Readonly<{ readonly name: string; readonly sourcePath: string }>;

/** One envoy, as the Studio renders it: what the manifest says, plus the file that declared it. */
export type StudioEnvoy = Readonly<{
	readonly name: string;
	readonly transport: string;
	readonly audience: string;
	readonly sourcePath?: string | undefined;
}>;

/** `src/capabilities/tools/+<name>.ts` — the filename *is* the tool name. */
const TOOL_FILE = /(?:^|\/)capabilities\/tools\/\+([^/]+)\.ts$/;
/** `src/envoys/+<name>.ts` — likewise the only part of the file that survives. */
const ENVOY_FILE = /(?:^|\/)envoys\/\+([^/]+)\.ts$/;

/**
 * The envoys this workspace declares, each with the file that declared it.
 *
 * There is no grouping under an agent, because there is no agent to group under: an envoy *is* one.
 * This used to return `StudioAgent` — one node per synthesized agent, with every channel and every
 * tool hung beneath it — and the synthesis meant the tree always had exactly one node above the
 * things anybody wanted to read.
 *
 * The manifest now carries `transport` and `audience`, so the note that used to explain what the
 * Studio could not know is gone with the projection that made it true.
 */
export const workspaceEnvoys = (
	manifest: WorkspaceManifest | undefined,
	files: ReadonlyArray<string> = []
): ReadonlyArray<StudioEnvoy> => {
	const source = new Map(
		files.flatMap((path) => {
			const name = ENVOY_FILE.exec(path)?.[1];
			return name === undefined ? [] : [[name, path] as const];
		})
	);
	return (manifest?.envoys ?? []).map(({ name, transport, audience }) => {
		const sourcePath = source.get(name);
		return { name, transport, audience, sourcePath };
	});
};

/**
 * Every tool this workspace authored, by the file that declared it.
 *
 * A flat list, not an agent's. A tool reaches a turn when a policy the subject holds names it, so
 * "whose tool is this" has no single answer — and hanging them under an agent asserted one.
 */
export const workspaceTools = (files: ReadonlyArray<string> = []): ReadonlyArray<StudioTool> =>
	files.flatMap((path) => {
		const name = TOOL_FILE.exec(path)?.[1];
		return name === undefined ? [] : [{ name, sourcePath: path }];
	});

type StudioMetric = Readonly<{
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
const formatBytes = (bytes: number): string => {
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
 * Operations' four resource tiles, each backed by something the host actually reported.
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
			detail: `Personal workbench at commit ${input.source?.commit.slice(0, 12) ?? 'none'}, ${plural(files.length, 'file')}.`
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
