import { Result, Schema } from 'effect';
import {
	COMPILED_MANIFEST_VERSION,
	EnvoyStatus as EnvoyStatusContract,
	ManifestDestination as ManifestDestinationSchema,
	SecretsStatus,
	WorkspaceAuthoringManifest
} from '@norbital-ai/bolt-protocol';
import type { CodeEditorLanguage } from '@norbital-ai/ui/code-editor';
import type { ProductIconName } from '@norbital-ai/ui/product-icon';

const UsageEstimateMeterSchema = Schema.Struct({
	kind: Schema.String,
	monthToDateQuantity: Schema.Number,
	projectedQuantity: Schema.Number,
	monthToDateMicroSgd: Schema.Number,
	projectedMicroSgd: Schema.Number,
	method: Schema.String
});

const UsageEstimateSchema = Schema.Struct({
	periodStartMillis: Schema.Number,
	periodEndMillis: Schema.Number,
	asOfMillis: Schema.Number,
	meters: Schema.Array(UsageEstimateMeterSchema),
	monthToDateMicroSgd: Schema.Number,
	projectedMicroSgd: Schema.Number
});

const sgd = new Intl.NumberFormat('en-SG', {
	style: 'currency',
	currency: 'SGD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

export const formatMicroSgd = (microSgd: number): string => sgd.format(microSgd / 1_000_000);

export const WorkbenchBuildReceiptSchema = Schema.Struct({
	effectId: Schema.String,
	commit: Schema.String,
	startedAt: Schema.String,
	completedAt: Schema.String,
	outcome: Schema.Literals(['succeeded', 'failed', 'migration_required']),
	cache: Schema.Literals(['hit', 'miss', 'not_reached']),
	phase: Schema.Literals(['prepare', 'checks', 'publish', 'provision', 'complete']),
	summary: Schema.String,
	stdout: Schema.optionalKey(Schema.String),
	stderr: Schema.optionalKey(Schema.String)
});
export type WorkbenchBuildReceipt = typeof WorkbenchBuildReceiptSchema.Type;

const SourceFileChangeSchema = Schema.Struct({
	path: Schema.NonEmptyString,
	before: Schema.NullOr(Schema.String),
	after: Schema.String
});

export const HostSnapshotSchema = Schema.Struct({
	capabilities: Schema.Struct({ canDecideReview: Schema.Boolean }),
	entries: Schema.Array(
		Schema.Struct({
			tenantId: Schema.String,
			environmentId: Schema.String,
			releaseId: Schema.String,
			artifactId: Schema.String,
			ownerEpoch: Schema.String
		})
	),
	usage: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			tenantId: Schema.String,
			kind: Schema.String,
			quantity: Schema.Number
		})
	),
	usageEstimate: Schema.NullOr(UsageEstimateSchema),
	capacity: Schema.Struct({
		limit: Schema.Number,
		active: Schema.Number,
		queued: Schema.Number,
		queueLimit: Schema.Number,
		tenantQueueLimit: Schema.Number
	}),
	source: Schema.Struct({
		tenantId: Schema.String,
		workspaceKey: Schema.String,
		baseCommit: Schema.NonEmptyString,
		commit: Schema.NonEmptyString,
		files: Schema.Record(Schema.String, Schema.String)
	}),
	sourceHistory: Schema.Array(
		Schema.Struct({
			commit: Schema.NonEmptyString,
			parent: Schema.NonEmptyString,
			changes: Schema.Array(SourceFileChangeSchema)
		})
	),
	conflicts: Schema.Array(Schema.NonEmptyString),
	releaseRequests: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			tenantId: Schema.NonEmptyString,
			environmentId: Schema.NonEmptyString,
			workspaceKey: Schema.NonEmptyString,
			authorId: Schema.NonEmptyString,
			commit: Schema.NonEmptyString,
			baseCommit: Schema.NonEmptyString,
			previewEnvironmentId: Schema.NonEmptyString,
			baseReleaseId: Schema.NullOr(Schema.NonEmptyString),
			releaseId: Schema.NonEmptyString,
			artifactId: Schema.NonEmptyString,
			checksum: Schema.NonEmptyString,
			schemaPlan: Schema.Struct({
				fingerprint: Schema.NonEmptyString,
				steps: Schema.Array(
					Schema.Struct({ id: Schema.NonEmptyString, sql: Schema.NonEmptyString })
				)
			}),
			status: Schema.Literals(['open', 'approving', 'approved', 'changes_requested', 'rejected']),
			reason: Schema.NullOr(Schema.String),
			createdAt: Schema.String,
			updatedAt: Schema.String,
			buildReceipt: Schema.Struct({
				effectId: Schema.String,
				commit: Schema.String,
				outcome: Schema.Literals(['succeeded', 'failed', 'migration_required']),
				summary: Schema.String
			}),
			changedFiles: Schema.Array(SourceFileChangeSchema)
		})
	),
	needsRebase: Schema.Boolean,
	preview: Schema.NullOr(
		Schema.Struct({
			workspaceKey: Schema.NonEmptyString,
			commit: Schema.NonEmptyString,
			baseCommit: Schema.NonEmptyString,
			previewEnvironmentId: Schema.NonEmptyString,
			releaseId: Schema.NonEmptyString,
			artifactId: Schema.NonEmptyString,
			expiresAtEpochMs: Schema.Number
		})
	),
	deploymentHistory: Schema.Array(Schema.NonEmptyString),
	facilities: Schema.Array(Schema.Struct({ name: Schema.String, available: Schema.Boolean })),
	buildReceipt: Schema.optionalKey(WorkbenchBuildReceiptSchema)
});
export type HostSnapshot = typeof HostSnapshotSchema.Type;
export type MatrixEntry = HostSnapshot['entries'][number];
type UsageObservation = HostSnapshot['usage'][number];
type SourceSnapshot = HostSnapshot['source'];
export type ReleaseRequest = HostSnapshot['releaseRequests'][number];
type ReleaseRequestStatus = ReleaseRequest['status'];

export type StudioRootTab = 'workbench' | 'review';
export type WorkbenchView = 'manifest' | 'editor';

type ReviewFreshness = 'current' | 'live_advanced' | 'terminal';
type ReviewNextOwner = 'author' | 'reviewer' | 'complete';
type WorkbenchPreviewState = 'missing' | 'expired' | 'stale' | 'current';

export const workbenchPreviewState = (input: {
	readonly preview:
		null | undefined | Readonly<{ readonly commit: string; readonly expiresAtEpochMs: number }>;
	readonly sourceCommit: string | undefined;
	readonly nowEpochMs: number;
}): WorkbenchPreviewState => {
	if (input.preview == null) return 'missing';
	if (input.preview.expiresAtEpochMs <= input.nowEpochMs) return 'expired';
	return input.preview.commit === input.sourceCommit ? 'current' : 'stale';
};

export const reviewFreshness = (
	request: ReleaseRequest,
	currentReleaseId: string | undefined
): ReviewFreshness =>
	request.status === 'approved' ||
	request.status === 'changes_requested' ||
	request.status === 'rejected'
		? 'terminal'
		: request.baseReleaseId === (currentReleaseId ?? null)
			? 'current'
			: 'live_advanced';

export const reviewNextOwner = (
	status: ReleaseRequestStatus,
	freshness: ReviewFreshness = 'current'
): ReviewNextOwner => {
	if (freshness === 'live_advanced' && (status === 'open' || status === 'approving'))
		return 'author';
	if (status === 'changes_requested') return 'author';
	if (status === 'open' || status === 'approving') return 'reviewer';
	return 'complete';
};

export const reviewStatusMessageKey = (status: ReleaseRequestStatus) => {
	if (status === 'open') return 'bolt.studio.reviewStatus.open';
	if (status === 'approving') return 'bolt.studio.reviewStatus.approving';
	if (status === 'approved') return 'bolt.studio.reviewStatus.approved';
	if (status === 'changes_requested') return 'bolt.studio.reviewStatus.changesRequested';
	return 'bolt.studio.reviewStatus.rejected';
};

export const reviewFreshnessMessageKey = (
	request: ReleaseRequest,
	currentReleaseId: string | undefined
) => {
	const freshness = reviewFreshness(request, currentReleaseId);
	if (freshness === 'current') return 'bolt.studio.current';
	if (freshness === 'live_advanced') return 'bolt.studio.liveAdvanced';
	return reviewStatusMessageKey(request.status);
};

export const reviewOwnerMessageKey = (
	request: ReleaseRequest,
	currentReleaseId: string | undefined
) => {
	const owner = reviewNextOwner(request.status, reviewFreshness(request, currentReleaseId));
	if (owner === 'author') return 'bolt.studio.author';
	if (owner === 'reviewer') return 'bolt.studio.reviewer';
	return 'bolt.studio.complete';
};

type ReviewRelativeTime = Readonly<{
	readonly messageKey:
		| 'bolt.studio.timeUnavailable'
		| 'bolt.studio.justNow'
		| 'bolt.studio.minutesAgo'
		| 'bolt.studio.hoursAgo'
		| 'bolt.studio.daysAgo';
	readonly count?: number;
}>;

export const reviewRelativeTime = (iso: string, nowEpochMs: number): ReviewRelativeTime => {
	const then = Date.parse(iso);
	if (!Number.isFinite(then)) return { messageKey: 'bolt.studio.timeUnavailable' };
	const elapsed = Math.max(0, nowEpochMs - then);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return { messageKey: 'bolt.studio.justNow' };
	if (minutes < 60) return { messageKey: 'bolt.studio.minutesAgo', count: minutes };
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return { messageKey: 'bolt.studio.hoursAgo', count: hours };
	return { messageKey: 'bolt.studio.daysAgo', count: Math.floor(hours / 24) };
};

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

export const sourceTreeMatches = (
	files: ReadonlyArray<string>,
	query: string,
	sizes: Readonly<Record<string, number>> = {}
): ReadonlyArray<SourceTreeEntry> => {
	const needle = query.trim().toLowerCase();
	if (needle === '') return [];
	const matches: Array<SourceTreeEntry> = [];
	for (const path of files) {
		if (!path.toLowerCase().includes(needle)) continue;
		matches.push({ name: path, type: 'file' as const, path, sizeBytes: sizes[path] ?? 0 });
	}
	return matches.sort((left, right) => left.path.localeCompare(right.path));
};

export const editorLanguage = (path: string): CodeEditorLanguage => {
	const file = path.split('/').pop()?.toLowerCase() ?? '';
	const ends = (...suffixes: string[]) => suffixes.some((suffix) => file.endsWith(suffix));
	if (ends('.json')) return 'json';
	if (ends('.yaml', '.yml')) return 'yaml';
	if (ends('.md', '.mdx', '.markdown')) return 'markdown';
	if (ends('.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx', '.svelte'))
		return 'javascript';
	return 'plaintext';
};

export const currentRoutedRelease = (
	entries: ReadonlyArray<MatrixEntry>
): MatrixEntry | undefined => {
	const routed = entries.filter((entry) => entry.releaseId !== '');
	return routed.find((entry) => entry.environmentId === 'live') ?? routed[0];
};

export type ReleaseControls = Readonly<{
	readonly canPreview: boolean;
	readonly canRequestReview: boolean;
	readonly canRollback: boolean;
	readonly reasonKey?: 'bolt.studio.controlBusy';
}>;

export const releaseControls = (
	input: Readonly<{ busy: boolean; hasRelease: boolean }>
): ReleaseControls => {
	if (input.busy) {
		return {
			canPreview: false,
			canRequestReview: false,
			canRollback: false,
			reasonKey: 'bolt.studio.controlBusy'
		};
	}
	return { canPreview: true, canRequestReview: true, canRollback: input.hasRelease };
};

export type ManifestDestination = typeof ManifestDestinationSchema.Type;
export const ManifestSchema = WorkspaceAuthoringManifest;
export type WorkspaceManifest = typeof ManifestSchema.Type;
export type ManifestCollection = WorkspaceManifest['collections'][number];

export const manifestInspectionState = (
	manifest: WorkspaceManifest | undefined
): 'current' | 'rebuild_required' =>
	manifest?.compiledManifestVersion === COMPILED_MANIFEST_VERSION ? 'current' : 'rebuild_required';

export const EnvironmentStatusSchema = SecretsStatus;
export type EnvironmentVariable = (typeof EnvironmentStatusSchema.Type)[number];

export const EnvoyStatusSchema = EnvoyStatusContract;
export type EnvoyStatus = typeof EnvoyStatusSchema.Type;

export const decodeManifest = (value: unknown): WorkspaceManifest | undefined => {
	const decoded = Schema.decodeUnknownResult(ManifestSchema)(value);
	return Result.isSuccess(decoded) ? decoded.success : undefined;
};

export const decodeEnvironmentStatus = (value: unknown): ReadonlyArray<EnvironmentVariable> => {
	const decoded = Schema.decodeUnknownResult(EnvironmentStatusSchema)(value);
	return Result.isSuccess(decoded) ? decoded.success : [];
};

export const decodeEnvoyStatus = (value: unknown): EnvoyStatus | undefined => {
	const decoded = Schema.decodeUnknownResult(EnvoyStatusSchema)(value);
	return Result.isSuccess(decoded) ? decoded.success : undefined;
};

type ManifestEntry = Readonly<{
	readonly name: string;
	readonly icon?: string | undefined;
}>;

export const MANIFEST_SECTION_MESSAGES = {
	collections: [
		'bolt.studio.section.collections',
		'bolt.studio.section.collectionsSummary',
		'bolt.studio.noCollections'
	],
	apps: ['bolt.studio.section.apps', 'bolt.studio.section.appsSummary', 'bolt.studio.noApps'],
	policies: [
		'bolt.studio.section.policies',
		'bolt.studio.section.policiesSummary',
		'bolt.studio.noPolicies'
	],
	envoys: [
		'bolt.studio.section.envoys',
		'bolt.studio.section.envoysSummary',
		'bolt.studio.noEnvoys'
	],
	automations: [
		'bolt.studio.section.automations',
		'bolt.studio.section.automationsSummary',
		'bolt.studio.noAutomations'
	],
	remotes: [
		'bolt.studio.section.remotes',
		'bolt.studio.section.remotesSummary',
		'bolt.studio.noRemotes'
	],
	environment: [
		'bolt.studio.section.environment',
		'bolt.studio.section.environmentSummary',
		'bolt.studio.noEnvironment'
	]
} as const;
type ManifestSectionId = keyof typeof MANIFEST_SECTION_MESSAGES;

export type ManifestSection = Readonly<{
	readonly id: ManifestSectionId;
	readonly icon: ProductIconName;
	readonly entries: ReadonlyArray<ManifestEntry>;
}>;

export const manifestSections = (
	manifest: WorkspaceManifest | undefined,
	environment: ReadonlyArray<{ readonly name: string }> = []
): ReadonlyArray<ManifestSection> => {
	if (manifest !== undefined && manifestInspectionState(manifest) === 'rebuild_required') return [];
	const applications = [...(manifest?.apps ?? []), ...(manifest?.appGroups ?? [])];
	const envoys = manifest?.envoys ?? [];
	return [
		{
			id: 'collections',
			icon: 'collections',
			entries: (manifest?.collections ?? []).map(({ name, icon }) => ({ name, icon }))
		},
		{ id: 'apps', icon: 'apps', entries: applications.map(({ name }) => ({ name })) },
		{
			id: 'policies',
			icon: 'policies',
			entries: (manifest?.policies ?? []).map(({ name }) => ({ name }))
		},
		{ id: 'envoys', icon: 'agent', entries: envoys.map(({ name }) => ({ name })) },
		{
			id: 'automations',
			icon: 'automations',
			entries: (manifest?.automations ?? []).map(({ name }) => ({ name }))
		},
		{
			id: 'remotes',
			icon: 'remotes',
			entries: (manifest?.remotes ?? []).map(({ name }) => ({ name }))
		},
		{ id: 'environment', icon: 'environment', entries: environment.map(({ name }) => ({ name })) }
	];
};

export const workspaceEnvoys = (
	manifest: WorkspaceManifest | undefined
): WorkspaceManifest['envoys'] =>
	manifest !== undefined && manifestInspectionState(manifest) === 'rebuild_required'
		? []
		: (manifest?.envoys ?? []);

type HookSummaryMessageKey =
	| 'bolt.studio.hook.mutatePrepare'
	| 'bolt.studio.hook.mutateBefore'
	| 'bolt.studio.hook.mutateAfter'
	| 'bolt.studio.hook.deleteBefore';

export const hookSummaryKey = (name: string): HookSummaryMessageKey | undefined => {
	if (name === 'mutate.prepare') return 'bolt.studio.hook.mutatePrepare';
	if (name === 'mutate.before') return 'bolt.studio.hook.mutateBefore';
	if (name === 'mutate.after') return 'bolt.studio.hook.mutateAfter';
	if (name === 'delete.before') return 'bolt.studio.hook.deleteBefore';
	return undefined;
};

type IntegrationBinding = NonNullable<
	WorkspaceManifest['integrations'][number]['bindings']
>[number];

export const integrationBindingSummary = (binding: IntegrationBinding): string => {
	const timing =
		binding.schedule === undefined
			? binding.events === undefined || binding.events.length === 0
				? undefined
				: binding.events.join(', ')
			: binding.schedule;
	return `${binding.method} ${binding.path}${timing === undefined ? '' : ` · ${timing}`}`;
};

type StudioMetric = Readonly<{
	readonly id: string;
	readonly labelKey:
		| 'bolt.studio.metric.hostDisk'
		| 'bolt.studio.metric.database'
		| 'bolt.studio.metric.objectStorage';
	readonly icon: string;
	readonly value: string | undefined;
	readonly detailKey:
		| 'bolt.studio.metric.hostDiskDetail'
		| 'bolt.studio.metric.databaseDetail'
		| 'bolt.studio.metric.objectStorageDetail';
	readonly detailValues?: Readonly<Record<string, string | number>>;
}>;

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

export const studioMetrics = (input: {
	readonly usage: ReadonlyArray<UsageObservation>;
	readonly source: SourceSnapshot | undefined;
}): ReadonlyArray<StudioMetric> => {
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
	return [
		{
			id: 'host-disk',
			labelKey: 'bolt.studio.metric.hostDisk',
			icon: 'lucide:hard-drive',
			value: input.source === undefined ? undefined : formatBytes(sourceBytes),
			detailKey: 'bolt.studio.metric.hostDiskDetail',
			detailValues: {
				commit: input.source?.commit.slice(0, 12) ?? '—',
				count: files.length
			}
		},
		{
			id: 'database',
			labelKey: 'bolt.studio.metric.database',
			icon: 'lucide:database',
			value: database === undefined ? undefined : meteredQuantity.format(database),
			detailKey: 'bolt.studio.metric.databaseDetail'
		},
		{
			id: 'object-storage',
			labelKey: 'bolt.studio.metric.objectStorage',
			icon: 'lucide:package-open',
			value: objects === undefined ? undefined : meteredQuantity.format(objects),
			detailKey: 'bolt.studio.metric.objectStorageDetail'
		}
	];
};
