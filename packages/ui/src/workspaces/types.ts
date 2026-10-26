import type { UsageChartProps } from '../chart/UsageChart.svelte';
import type { ReleaseBuild, ReleaseEnvironment, ReleaseVersion } from '../releases/model.js';

/** The time window shown by workspace monitoring. */
export type WorkspaceRange = '24h' | '7d' | '30d';
/** The selected workspace monitoring view. */
export type WorkspaceView = 'activity' | 'resources' | 'logs' | 'users';
/** The monitoring view, time window and optional build or run selection. */
export type WorkspaceScope = Readonly<{
	view?: WorkspaceView;
	range?: WorkspaceRange;
	build?: string | null;
	run?: string | null;
}>;
/** The monitoring controls are a subset of native Studio operations; source and approval writes stay in Studio. */
export type WorkspaceOperation =
	| Readonly<{ op: 'preview'; id: string }>
	| Readonly<{ op: 'change.open'; id: string }>
	| Readonly<{ op: 'change.merge'; id: string; accept?: readonly string[] }>
	| Readonly<{ op: 'change.close'; id: string }>
	| Readonly<{ op: 'rollback'; commit: string; discardDataSince?: string }>;
export type WorkspaceMember = Readonly<{
	id: string;
	name: string;
	email: string | null;
	active: boolean;
	lastSeen: string | null;
}>;
export type WorkspaceChange = Readonly<{
	id: string;
	title: string;
	state: 'open' | 'merged' | 'closed';
	head: string;
	createdAt: string;
	updatedAt: string;
	behind?: number;
	merge?: Readonly<{ state: 'running' | 'failed'; at: string; head: string; error?: string }>;
	preview: Readonly<{
		url: string | null;
		commit: string;
		artifact: string;
		stale: boolean;
		shelved?: boolean;
		destructive?: readonly string[];
	}> | null;
}>;
type BuildLine = Readonly<{ at: string; level: 'info' | 'warn' | 'error'; message: string }>;
/** Plain operational data rendered identically in tenant Studio and Realm. Host boundaries decode its native schema. */
export type WorkspaceOperationsData = Readonly<{
	canInspect: boolean;
	asOf: string;
	usage: readonly UsageChartProps[];
	members: readonly WorkspaceMember[] | null;
	studio: Readonly<{
		commit: string;
		message: string;
		builds: readonly ReleaseBuild[];
		releases: readonly ReleaseVersion[];
		environments: readonly ReleaseEnvironment[];
		changes: readonly WorkspaceChange[];
		log: readonly BuildLine[];
		diagnostics: readonly unknown[];
		build: Readonly<{
			build: ReleaseBuild;
			log: readonly BuildLine[];
			diagnostics: readonly unknown[];
		}> | null;
	}> | null;
	logs:
		| readonly Readonly<{
				id: string;
				at: string;
				severity: 'info' | 'warn' | 'error';
				event: string;
				invocation: string;
				run: string | null;
				conversation: string | null;
				turn: string | null;
				attributes: unknown;
		  }>[]
		| null;
	bundles: Readonly<{
		commit: string | null;
		live: boolean;
		name: string;
		digest: string;
		contentAddress: string | null;
		contract: string;
		schema: string;
		assetCount: number | null;
		assets: readonly Readonly<{ path: string; sha256: string; bytes: number | null }>[];
		truncated: boolean;
		totalBytes: number | null;
	}> | null;
	cache: Readonly<{
		budgetBytes: number;
		hostBytes: number;
		hostEntries: number;
		releaseBytes: number;
		releaseEntries: number;
		assets: readonly Readonly<{
			path: string;
			sha256: string;
			cachedBytes: number;
			variants: readonly Readonly<{ encoding: 'identity' | 'br' | 'gzip'; bytes: number }>[];
		}>[];
	}> | null;
	errors: Readonly<{
		access: string | null;
		studio: string | null;
		logs: string | null;
		bundles: string | null;
		cache: string | null;
		build: string | null;
	}> | null;
	filters: Readonly<{
		level: 'info' | 'warn' | 'error' | null;
		text: string;
		run: string;
		build: string | null;
	}>;
	health?: Readonly<{
		artifactBytes: number | null;
		fileCount: number | null;
		packages: readonly Readonly<{
			name: string;
			version: string;
			source: 'artifact' | 'runtime';
		}>[];
		errors: readonly string[];
		cleanup: readonly Readonly<{
			changeId: string;
			title: string;
			state: 'open' | 'merged' | 'closed';
			environment: string;
			status: 'active' | 'shelved' | 'cleared' | 'leftover' | 'unknown';
			reason: string;
		}>[];
	}>;
}>;
