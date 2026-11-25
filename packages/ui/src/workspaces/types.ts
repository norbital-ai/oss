import type { UsageChartProps } from '../chart/UsageChart.svelte';
import type { ReleaseBuild, ReleaseEnvironment, ReleaseVersion } from '../releases/model.js';

/** The time window shown by workspace monitoring. */
export type WorkspaceRange = '24h' | '7d' | '30d';
/** The selected workspace monitoring view. */
export type WorkspaceView =
	| 'bundle'
	| 'telemetry'
	| 'logs'
	| 'users'
	| 'activity'
	| 'improvements';
/** The monitoring view, time window and optional build or run selection. */
export type WorkspaceScope = Readonly<{
	view?: WorkspaceView;
	range?: WorkspaceRange;
	build?: string | null;
	run?: string | null;
}>;
export type WorkspaceMember = Readonly<{
	id: string;
	name: string;
	email: string | null;
	active: boolean;
	last_seen: string | null;
}>;
export type WorkspaceChange = Readonly<{
	id: string;
	title: string;
	state: 'open' | 'merged' | 'closed';
	head: string;
	created_at: string;
	updated_at: string;
	behind?: number;
	merge?: Readonly<{
		state: 'scheduled' | 'queued' | 'running' | 'failed';
		at: string;
		head: string;
		error?: string;
		run_at?: string;
	}>;
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
	can_inspect: boolean;
	as_of: string;
	usage: readonly Omit<UsageChartProps, 'ctx'>[];
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
		content_address: string | null;
		contract: string;
		schema: string;
		asset_count: number | null;
		assets: readonly Readonly<{ path: string; sha256: string; bytes: number | null }>[];
		truncated: boolean;
		total_bytes: number | null;
	}> | null;
	cache: Readonly<{
		budget_bytes: number;
		host_bytes: number;
		host_entries: number;
		release_bytes: number;
		release_entries: number;
		assets: readonly Readonly<{
			path: string;
			sha256: string;
			cached_bytes: number;
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
		artifact_bytes: number | null;
		file_count: number | null;
		packages: readonly Readonly<{
			name: string;
			version: string;
			source: 'artifact' | 'runtime';
		}>[];
		errors: readonly string[];
		cleanup: readonly Readonly<{
			change_id: string;
			title: string;
			state: 'open' | 'merged' | 'closed';
			environment: string;
			status: 'active' | 'shelved' | 'cleared' | 'leftover' | 'unknown';
			reason: string;
		}>[];
	}>;
	/** How the workspace was used over the range; `null`: the host does not serve it, or it was not asked for. */
	activity: Readonly<{
		people: number;
		pages: readonly Readonly<{
			route: string;
			views: number;
			people: number;
			dwell_ms: number | null;
		}>[];
		turns: readonly Readonly<{
			audience: string;
			turns: number;
			failed: number;
			steps: number;
			tool_errors: number;
			cost: number;
		}>[];
	}> | null;
	/** The improvement threads; `null`: the host does not serve them, or they were not asked for. */
	improvements: Readonly<{
		threads: readonly Readonly<{
			id: string;
			status: string;
			title: string;
			seen: number;
			updated_at: string;
			last: string | null;
			change: string | null;
		}>[];
	}> | null;
}>;
