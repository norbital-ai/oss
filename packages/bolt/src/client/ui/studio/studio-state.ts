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

const WorkbenchBuildReceiptSchema = Schema.Struct({
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
	capabilities: Schema.Struct({
		canDecideReview: Schema.Boolean,
		pointInTime: Schema.optionalKey(Schema.Boolean)
	}),
	checkpoints: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				at: Schema.String,
				environment: Schema.NonEmptyString,
				commit: Schema.NullOr(Schema.NonEmptyString)
			})
		)
	),
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
	mergeRequests: Schema.Array(
		Schema.Struct({
			id: Schema.NonEmptyString,
			tenantId: Schema.NonEmptyString,
			environmentId: Schema.NonEmptyString,
			workspaceKey: Schema.NonEmptyString,
			openedBy: Schema.NonEmptyString,
			trackedBy: Schema.Array(Schema.NonEmptyString),
			title: Schema.String,
			commits: Schema.Array(
				Schema.Struct({
					commit: Schema.NonEmptyString,
					by: Schema.NonEmptyString,
					at: Schema.String,
					message: Schema.String
				})
			),
			head: Schema.NonEmptyString,
			artifactId: Schema.NonEmptyString,
			releaseId: Schema.NonEmptyString,
			previewEnvironmentId: Schema.NonEmptyString,
			baseCommit: Schema.NonEmptyString,
			baseReleaseId: Schema.NullOr(Schema.NonEmptyString),
			checksum: Schema.NonEmptyString,
			schemaPlan: Schema.Struct({
				fingerprint: Schema.NonEmptyString,
				steps: Schema.Array(
					Schema.Struct({ id: Schema.NonEmptyString, sql: Schema.NonEmptyString })
				)
			}),
			state: Schema.Literals(['draft', 'ready', 'merged', 'closed']),
			decision: Schema.NullOr(
				Schema.Struct({
					kind: Schema.Literals(['approved', 'changes_requested', 'rejected']),
					commit: Schema.NonEmptyString,
					by: Schema.NonEmptyString,
					at: Schema.String,
					reason: Schema.NullOr(Schema.String)
				})
			),
			createdAt: Schema.String,
			updatedAt: Schema.String,
			buildReceipt: WorkbenchBuildReceiptSchema,
			deployLog: Schema.Array(
				Schema.Struct({
					at: Schema.String,
					level: Schema.NonEmptyString,
					line: Schema.String
				})
			),
			changedFiles: Schema.Array(SourceFileChangeSchema),
			diagnosis: Schema.Struct({
				sourceDigest: Schema.NonEmptyString,
				ranAt: Schema.String,
				origin: Schema.Literals(['diagnose', 'preview']),
				errors: Schema.Number,
				warnings: Schema.Number,
				hints: Schema.Number,
				findings: Schema.Array(
					Schema.Struct({
						severity: Schema.Literals(['error', 'warning', 'hint']),
						rule: Schema.String,
						summary: Schema.String,
						location: Schema.String,
						principles: Schema.Array(Schema.String)
					})
				)
			}),
			manifest: Schema.Struct({
				artifactId: Schema.NonEmptyString,
				checksum: Schema.NonEmptyString
			})
		})
	),
	tracking: Schema.Union([Schema.Literal('live'), Schema.NonEmptyString]),
	diagnosis: Schema.NullOr(
		Schema.Struct({
			sourceDigest: Schema.NonEmptyString,
			ranAt: Schema.String,
			origin: Schema.Literals(['diagnose', 'preview']),
			errors: Schema.Number,
			warnings: Schema.Number,
			hints: Schema.Number,
			findings: Schema.Array(
				Schema.Struct({
					severity: Schema.Literals(['error', 'warning', 'hint']),
					rule: Schema.String,
					summary: Schema.String,
					location: Schema.String,
					principles: Schema.Array(Schema.String)
				})
			)
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
	releases: Schema.Array(
		Schema.Struct({
			releaseId: Schema.NonEmptyString,
			buildLog: Schema.optionalKey(WorkbenchBuildReceiptSchema),
			deployLog: Schema.Array(
				Schema.Struct({
					at: Schema.String,
					level: Schema.NonEmptyString,
					line: Schema.String
				})
			)
		})
	),
	facilities: Schema.Array(Schema.Struct({ name: Schema.String, available: Schema.Boolean }))
});
export type HostSnapshot = typeof HostSnapshotSchema.Type;
export type MatrixEntry = HostSnapshot['entries'][number];
export type MergeRequest = HostSnapshot['mergeRequests'][number];
type ReleaseEvidence = HostSnapshot['releases'][number];

type MergeRequestState = MergeRequest['state'];

const STUDIO_ROOT_TABS = ['documentation', 'workbench', 'changes', 'live'] as const;
export type StudioRootTab = (typeof STUDIO_ROOT_TABS)[number];

const CHANGES_VIEWS = ['manifest', 'files', 'data', 'conversation', 'logs'] as const;
export type ChangesView = (typeof CHANGES_VIEWS)[number];

type StudioOwnedSurface = 'manifest' | 'logs' | 'lifecycle' | 'diagnosis';

export const isStudioRootTab = (value: string): value is StudioRootTab => {
	switch (value) {
		case 'documentation':
		case 'workbench':
		case 'changes':
		case 'live':
			return true;
		default:
			return false;
	}
};

export const isChangesView = (value: string): value is ChangesView => {
	switch (value) {
		case 'manifest':
		case 'files':
		case 'data':
		case 'conversation':
		case 'logs':
			return true;
		default:
			return false;
	}
};

export const studioTabOwns = (tab: StudioRootTab, surface: StudioOwnedSurface): boolean => {
	switch (tab) {
		case 'documentation':
			return false;
		case 'workbench':
			return surface === 'diagnosis';
		case 'changes':
			return surface === 'manifest' || surface === 'logs' || surface === 'lifecycle';
		case 'live':
			return surface === 'manifest' || surface === 'logs';
		default: {
			const unhandled: never = tab;
			throw new Error(`Unhandled studio tab: ${String(unhandled)}`);
		}
	}
};

export type WorkbenchDiffBaselineKey =
	'bolt.studio.diff.againstMrHead' | 'bolt.studio.diff.againstLive';

export const workbenchDiffBaselineKey = (
	tracking: HostSnapshot['tracking'] | undefined
): WorkbenchDiffBaselineKey =>
	tracking === undefined || tracking === 'live'
		? 'bolt.studio.diff.againstLive'
		: 'bolt.studio.diff.againstMrHead';

export const CHANGES_DIFF_BASELINE_KEY = 'bolt.studio.diff.againstBase' as const;

export const newCommitsBehindHead = (input: {
	readonly sourceCommit: string | undefined;
	readonly tracking: HostSnapshot['tracking'] | undefined;
	readonly mergeRequests: ReadonlyArray<MergeRequest>;
}): number => {
	if (input.tracking === undefined || input.tracking === 'live') return 0;
	const request = input.mergeRequests.find((row) => row.id === input.tracking);
	if (request === undefined) return 0;
	if (input.sourceCommit === undefined || input.sourceCommit === request.head) return 0;
	const index = request.commits.findIndex((row) => row.commit === input.sourceCommit);
	if (index === -1) return request.commits.length;
	return Math.max(0, request.commits.length - index - 1);
};

export const LIFECYCLE_RAIL = ['draft', 'ready', 'merged'] as const;
type LifecycleRailStage = (typeof LIFECYCLE_RAIL)[number];

export const lifecycleRailMessageKey = (
	stage: LifecycleRailStage
):
	| 'bolt.studio.lifecycle.draft'
	| 'bolt.studio.lifecycle.ready'
	| 'bolt.studio.lifecycle.merged' => {
	switch (stage) {
		case 'draft':
			return 'bolt.studio.lifecycle.draft';
		case 'ready':
			return 'bolt.studio.lifecycle.ready';
		case 'merged':
			return 'bolt.studio.lifecycle.merged';
		default: {
			const unhandled: never = stage;
			throw new Error(`Unhandled lifecycle stage: ${String(unhandled)}`);
		}
	}
};

export const lifecycleRailCurrent = (state: MergeRequestState): LifecycleRailStage | 'closed' => {
	switch (state) {
		case 'draft':
			return 'draft';
		case 'ready':
			return 'ready';
		case 'merged':
			return 'merged';
		case 'closed':
			return 'closed';
		default: {
			const unhandled: never = state;
			throw new Error(`Unhandled merge request state: ${String(unhandled)}`);
		}
	}
};

export const lifecycleRailReached = (
	state: MergeRequestState,
	stage: LifecycleRailStage
): boolean => {
	if (state === 'closed') return false;
	if (stage === 'draft') return true;
	if (stage === 'ready') return state === 'ready' || state === 'merged';
	return state === 'merged';
};

export const boundTriple = (
	request: MergeRequest
): Readonly<{
	readonly commit: string;
	readonly bundle: string;
	readonly fork: string;
}> => ({
	commit: request.head,
	bundle: request.artifactId,
	fork: request.previewEnvironmentId
});

export const canWorkOnMergeRequest = (
	request: MergeRequest,
	tracking: HostSnapshot['tracking'] | undefined
): boolean => (request.state === 'draft' || request.state === 'ready') && request.id !== tracking;

export const mergeRequestEvidence = (
	request: MergeRequest | undefined
): Readonly<{
	readonly build: WorkbenchBuildReceipt | undefined;
	readonly deploy: ReleaseEvidence['deployLog'];
}> => {
	if (request === undefined) return { build: undefined, deploy: [] };
	return { build: request.buildReceipt, deploy: request.deployLog };
};

export type LiveReleaseRow = Readonly<{
	readonly releaseId: string;
	readonly artifactId: string | undefined;
	readonly current: boolean;
	readonly commit: string | undefined;
	readonly checkpointAt: string | undefined;
	readonly build: WorkbenchBuildReceipt | undefined;
	readonly deploy: ReleaseEvidence['deployLog'];
}>;

export const liveReleaseTimeline = (
	snapshot: HostSnapshot | undefined
): ReadonlyArray<LiveReleaseRow> => {
	if (snapshot === undefined) return [];
	const current = currentRoutedRelease(snapshot.entries);
	const evidence = new Map(snapshot.releases.map((row) => [row.releaseId, row]));
	const artifactByRelease = new Map(
		snapshot.entries
			.filter((row) => row.releaseId !== '')
			.map((row) => [row.releaseId, row.artifactId])
	);
	const ids: string[] = [];
	const seen = new Set<string>();
	const push = (id: string): void => {
		if (id === '' || seen.has(id)) return;
		seen.add(id);
		ids.push(id);
	};
	if (current !== undefined) push(current.releaseId);
	for (const id of [...snapshot.deploymentHistory].reverse()) push(id);
	for (const row of [...snapshot.releases].reverse()) push(row.releaseId);
	const checkpoints = snapshot.checkpoints ?? [];
	return ids.map((releaseId) => {
		const row = evidence.get(releaseId);
		const commit = row?.buildLog?.commit;
		const tagged = checkpoints.findLast(
			(entry) => entry.commit === releaseId || (commit !== undefined && entry.commit === commit)
		);
		return {
			releaseId,
			artifactId: artifactByRelease.get(releaseId),
			current: current?.releaseId === releaseId,
			commit,
			checkpointAt: tagged?.at,
			build: row?.buildLog,
			deploy: row?.deployLog ?? []
		};
	});
};

export const canRestoreRelease = (input: {
	readonly busy: boolean;
	readonly selected: LiveReleaseRow | undefined;
}): boolean => !input.busy && input.selected !== undefined && !input.selected.current;

type SourceFileMark = 'M' | 'A' | 'D';

export const sourceFileMark = (
	path: string,
	drafts: Readonly<Record<string, string>>,
	sourceFiles: Readonly<Record<string, string>>
): SourceFileMark | undefined => {
	if (!Object.hasOwn(drafts, path)) return undefined;
	const existed = Object.hasOwn(sourceFiles, path);
	if (!existed) return 'A';
	if ((drafts[path] ?? '') === '') return 'D';
	return 'M';
};

const sourceTreeHasDirtyDescendant = (
	directoryPath: string,
	drafts: Readonly<Record<string, string>>,
	sourceFiles: Readonly<Record<string, string>>
): boolean => {
	const prefix = directoryPath === '' ? '' : `${directoryPath}/`;
	return Object.keys(drafts).some(
		(path) =>
			(prefix === '' || path.startsWith(prefix)) &&
			sourceFileMark(path, drafts, sourceFiles) !== undefined
	);
};

export const sourceTreeEntryBadge = (
	entry: Readonly<{ readonly type: 'directory' | 'file'; readonly path: string }>,
	drafts: Readonly<Record<string, string>>,
	sourceFiles: Readonly<Record<string, string>>
): Readonly<{ readonly label: string; readonly class?: string }> | null => {
	if (entry.type === 'directory') {
		return sourceTreeHasDirtyDescendant(entry.path, drafts, sourceFiles) ? { label: '·' } : null;
	}
	const mark = sourceFileMark(entry.path, drafts, sourceFiles);
	if (mark === undefined) return null;
	switch (mark) {
		case 'M':
			return { label: 'M', class: 'text-amber-700 dark:text-amber-300' };
		case 'A':
			return { label: 'A', class: 'text-emerald-700 dark:text-emerald-300' };
		case 'D':
			return { label: 'D', class: 'text-destructive' };
		default: {
			const unhandled: never = mark;
			throw new Error(`Unhandled source file mark: ${String(unhandled)}`);
		}
	}
};

type DiagnosisFinding = NonNullable<HostSnapshot['diagnosis']>['findings'][number];

type WorkbenchDiagnosisState = 'missing' | 'stale' | 'errors' | 'clean';

export const workbenchDiagnosisState = (input: {
	readonly diagnosis: HostSnapshot['diagnosis'];
	readonly draftCount: number;
}): WorkbenchDiagnosisState => {
	if (input.diagnosis == null) return 'missing';
	if (input.draftCount > 0) return 'stale';
	if (input.diagnosis.errors > 0) return 'errors';
	return 'clean';
};

export const diagnosisFindingPath = (location: string): string =>
	location.split(':')[0] ?? location;

export const diagnosisFindingsByFile = (
	findings: ReadonlyArray<DiagnosisFinding>
): ReadonlyArray<{
	readonly file: string;
	readonly findings: ReadonlyArray<DiagnosisFinding>;
}> => {
	const groups = new Map<string, DiagnosisFinding[]>();
	for (const finding of findings) {
		const file = diagnosisFindingPath(finding.location);
		groups.set(file, [...(groups.get(file) ?? []), finding]);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([file, rows]) => ({ file, findings: rows }));
};

export const schemaPlanSentence = (sql: string): string => {
	const first =
		sql
			.split('\n')
			.find((line) => line.trim() !== '')
			?.trim() ?? sql;
	return first.endsWith(';') ? first.slice(0, -1) : first;
};

export const policyActionVerbs = (grants: ReadonlyArray<{ readonly action: string }>): string =>
	[...new Set(grants.map((grant) => grant.action))].join(' · ');

type ReviewFreshness = 'current' | 'live_advanced' | 'terminal';
type ReviewNextOwner = 'author' | 'reviewer' | 'complete';

export const reviewFreshness = (
	request: MergeRequest,
	currentReleaseId: string | undefined
): ReviewFreshness =>
	request.state === 'merged' || request.state === 'closed'
		? 'terminal'
		: request.baseReleaseId === (currentReleaseId ?? null)
			? 'current'
			: 'live_advanced';

export const reviewNextOwner = (
	state: MergeRequestState,
	freshness: ReviewFreshness = 'current',
	decision: MergeRequest['decision'] = null
): ReviewNextOwner => {
	if (state === 'merged' || state === 'closed') return 'complete';
	if (freshness === 'live_advanced') return 'author';
	if (decision?.kind === 'changes_requested') return 'author';
	if (state === 'ready') return 'reviewer';
	return 'author';
};

const reviewStatusMessageKey = (state: MergeRequestState) => {
	if (state === 'draft') return 'bolt.studio.reviewStatus.open';
	if (state === 'ready') return 'bolt.studio.reviewStatus.approving';
	if (state === 'merged') return 'bolt.studio.reviewStatus.approved';
	return 'bolt.studio.reviewStatus.rejected';
};

export const reviewFreshnessMessageKey = (
	request: MergeRequest,
	currentReleaseId: string | undefined
) => {
	const freshness = reviewFreshness(request, currentReleaseId);
	if (freshness === 'current') return 'bolt.studio.current';
	if (freshness === 'live_advanced') return 'bolt.studio.liveAdvanced';
	return reviewStatusMessageKey(request.state);
};

export const reviewOwnerMessageKey = (
	request: MergeRequest,
	currentReleaseId: string | undefined
) => {
	const owner = reviewNextOwner(
		request.state,
		reviewFreshness(request, currentReleaseId),
		request.decision
	);
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

type ReleaseControls = Readonly<{
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

const EnvironmentStatusSchema = SecretsStatus;
export type EnvironmentVariable = (typeof EnvironmentStatusSchema.Type)[number];

const EnvoyStatusSchema = EnvoyStatusContract;
export type EnvoyStatus = typeof EnvoyStatusSchema.Type;

const decodeManifest = (value: unknown): WorkspaceManifest | undefined => {
	const decoded = Schema.decodeUnknownResult(ManifestSchema)(value);
	return Result.isSuccess(decoded) ? decoded.success : undefined;
};

const decodeEnvironmentStatus = (value: unknown): ReadonlyArray<EnvironmentVariable> => {
	const decoded = Schema.decodeUnknownResult(EnvironmentStatusSchema)(value);
	return Result.isSuccess(decoded) ? decoded.success : [];
};

const decodeEnvoyStatus = (value: unknown): EnvoyStatus | undefined => {
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
	| 'bolt.studio.hook.deletePrepare'
	| 'bolt.studio.hook.deleteBefore';

export const hookSummaryKey = (name: string): HookSummaryMessageKey | undefined => {
	if (name === 'mutate.prepare') return 'bolt.studio.hook.mutatePrepare';
	if (name === 'mutate.before') return 'bolt.studio.hook.mutateBefore';
	if (name === 'mutate.after') return 'bolt.studio.hook.mutateAfter';
	if (name === 'delete.prepare') return 'bolt.studio.hook.deletePrepare';
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
