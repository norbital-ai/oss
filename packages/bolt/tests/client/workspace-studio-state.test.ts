import { describe, expect, expectTypeOf, it } from 'vitest';
import { Schema } from 'effect';
import { COMPILED_MANIFEST_VERSION } from '@norbital-ai/bolt-protocol';
import type { AgentRuntimeConfig } from '../../src/client/ui/agent/client.svelte.js';
import type { AutomationRunsClient } from '../../src/client/ui/studio/workspace-client.js';
import {
	ManifestSchema,
	formatMicroSgd,
	hookSummaryKey,
	integrationBindingSummary,
	manifestInspectionState,
	manifestSections,
	reviewFreshness,
	reviewNextOwner,
	reviewRelativeTime,
	workbenchPreviewState,
	workspaceEnvoys,
	boundTriple,
	canWorkOnMergeRequest,
	CHANGES_DIFF_BASELINE_KEY,
	evidenceLogs,
	liveReleaseTimeline,
	newCommitsBehindHead,
	sourceFileMark,
	sourceTreeEntryBadge,
	studioTabOwns,
	studioTabOwnership,
	workbenchDiagnosisState,
	workbenchDiffBaselineKey,
	type HostSnapshot,
	type ReleaseRequest
} from '../../src/client/ui/studio/studio-state.js';
import {
	AUTOMATIONS_PATH,
	automationsHref,
	buildSystemNavigation,
	buildWorkspaceNavigationSections,
	manifestDestinationHref
} from '../../src/client/ui/shell/workspace-navigation.js';

const request = (overrides: Partial<ReleaseRequest> = {}): ReleaseRequest => ({
	id: 'review-1',
	tenantId: 'tenant-1',
	environmentId: 'live',
	workspaceKey: 'workspace-1',
	openedBy: 'author-1',
	trackedBy: ['author-1'],
	title: 'src/app.ts',
	commits: [
		{
			commit: 'candidate-commit',
			by: 'author-1',
			at: '2026-09-01T00:00:00.000Z',
			message: 'Publish'
		}
	],
	head: 'candidate-commit',
	baseCommit: 'base-commit',
	previewEnvironmentId: 'preview-1',
	baseReleaseId: 'release-1',
	releaseId: 'release-2',
	artifactId: 'artifact-2',
	checksum: 'checksum-2',
	schemaPlan: { fingerprint: 'schema-1', steps: [] },
	state: 'ready',
	decision: null,
	createdAt: '2026-09-01T00:00:00.000Z',
	updatedAt: '2026-09-01T00:30:00.000Z',
	buildReceipt: {
		effectId: 'effect-1',
		commit: 'candidate-commit',
		startedAt: '2026-09-01T00:00:00.000Z',
		completedAt: '2026-09-01T00:00:30.000Z',
		outcome: 'succeeded',
		cache: 'miss',
		phase: 'complete',
		summary: 'Preview ready',
		stdout: 'built'
	},
	deployLog: [],
	changedFiles: [],
	diagnosis: {
		sourceDigest: 'a'.repeat(64),
		ranAt: '2026-09-01T00:00:00.000Z',
		origin: 'diagnose',
		errors: 0,
		warnings: 0,
		hints: 0,
		findings: []
	},
	manifest: { artifactId: 'artifact-2', checksum: 'checksum-2' },
	...overrides
});

describe('Workspace Studio collaboration presentation', () => {
	it('derives freshness from routed releases without inspecting another author workbench', () => {
		expect(reviewFreshness(request(), 'release-1')).toBe('current');
		expect(reviewFreshness(request(), 'release-2')).toBe('live_advanced');
		expect(reviewFreshness(request({ state: 'closed' }), 'release-2')).toBe('terminal');
	});

	it('names the next human owner from the existing merge-request state', () => {
		expect(reviewNextOwner('ready')).toBe('reviewer');
		expect(reviewNextOwner('draft')).toBe('author');
		expect(reviewNextOwner('ready', 'current', { kind: 'changes_requested', commit: 'x', by: 'r', at: 't', reason: 'n' })).toBe('author');
		expect(reviewNextOwner('merged')).toBe('complete');
		expect(reviewNextOwner('ready', 'live_advanced')).toBe('author');
	});

	it('presents review age and Preview validity without inventing shared draft state', () => {
		expect(
			reviewRelativeTime('2026-09-01T00:30:00.000Z', Date.parse('2026-09-01T02:00:00.000Z'))
		).toEqual({ messageKey: 'bolt.studio.hoursAgo', count: 1 });
		expect(reviewRelativeTime('invalid', 0)).toEqual({
			messageKey: 'bolt.studio.timeUnavailable'
		});
		expect(
			workbenchPreviewState({
				preview: { commit: 'candidate', expiresAtEpochMs: 2_000 },
				sourceCommit: 'candidate',
				nowEpochMs: 1_000
			})
		).toBe('current');
		expect(
			workbenchPreviewState({
				preview: { commit: 'candidate', expiresAtEpochMs: 1_000 },
				sourceCommit: 'candidate',
				nowEpochMs: 1_000
			})
		).toBe('expired');
		expect(
			workbenchPreviewState({
				preview: { commit: 'older', expiresAtEpochMs: 2_000 },
				sourceCommit: 'candidate',
				nowEpochMs: 1_000
			})
		).toBe('stale');
	});
});

describe('Workspace Studio manifest handoff', () => {
	it('retains compiler-projected source paths, semantic destinations, and authored pipelines', () => {
		const manifest = Schema.decodeUnknownSync(ManifestSchema)({
			name: 'Workspace',
			version: '1',
			compiledManifestVersion: COMPILED_MANIFEST_VERSION,
			collections: [
				{
					name: 'jobs',
					history: true,
					sourcePath: 'src/collections/jobs/+model.ts',
					destination: { kind: 'system', surface: 'data', selection: 'jobs' },
					hookDeclarations: [
						{
							name: 'mutate.before',
							description: 'Validates a job',
							sourcePath: 'src/collections/jobs/+hooks.ts',
							origin: 'authored'
						}
					],
					pipelines: [
						{
							name: 'collections.export',
							description: 'Exports jobs',
							sourcePath: 'src/collections/jobs/+pipelines.ts'
						}
					],
					fields: [],
					relations: []
				}
			],
			apps: [
				{
					name: 'jobs',
					label: 'Jobs',
					sourcePath: 'src/apps/jobs/+app.ts',
					destination: { kind: 'app', name: 'jobs' }
				}
			],
			appGroups: [
				{
					name: 'operations',
					label: 'Operations',
					sourcePath: 'src/apps/operations/+group.ts',
					origin: 'authored',
					destination: { kind: 'app', name: 'operations' }
				}
			],
			policies: [
				{
					name: 'operator',
					description: 'Operates jobs',
					sourcePath: 'src/access/policies/+operator.ts',
					origin: 'authored',
					grants: [],
					capabilities: { apps: [], tools: [], mcp: [], skills: [] }
				}
			],
			automations: [
				{
					name: 'daily',
					sourcePath: 'src/automations/+daily.ts',
					origin: 'authored',
					destination: { kind: 'system', surface: 'automations', selection: 'daily' },
					trigger: { _tag: 'Manual' },
					policies: []
				}
			],
			envoys: [
				{
					name: 'support',
					transport: 'web',
					audience: 'authenticated',
					delegation: 'disabled',
					sourcePath: 'src/envoys/+support.ts',
					origin: 'authored',
					destination: { kind: 'system', surface: 'envoys', selection: 'support' }
				}
			],
			integrations: [
				{
					name: 'jobs.erp',
					collection: 'jobs',
					sourcePath: 'src/collections/jobs/+integrations.ts',
					origin: 'authored',
					bindings: [
						{
							name: 'pull',
							direction: 'receive',
							method: 'GET',
							path: '/jobs',
							schedule: '0 * * * *',
							targetCollection: 'jobs',
							source: 'jobs.erp'
						}
					]
				}
			],
			remotes: [{ name: 'summary', sourcePath: 'src/functions/+summary.ts', origin: 'authored' }],
			environment: [
				{
					name: 'ERP_TOKEN',
					label: 'ERP token',
					secret: true,
					sourcePath: 'src/+env.ts',
					origin: 'authored',
					destination: { kind: 'system', surface: 'environment' }
				}
			],
			principals: [],
			requiredFacilities: []
		});

		expect(manifest.apps[0]?.sourcePath).toBe('src/apps/jobs/+app.ts');
		expect(manifest.collections[0]?.pipelines?.[0]?.name).toBe('collections.export');
		expect(manifest.compiledManifestVersion).toBe(COMPILED_MANIFEST_VERSION);
		expect([
			manifest.collections[0]?.sourcePath,
			manifest.collections[0]?.hookDeclarations?.[0]?.sourcePath,
			manifest.collections[0]?.pipelines?.[0]?.sourcePath,
			manifest.apps[0]?.sourcePath,
			manifest.appGroups?.[0]?.sourcePath,
			manifest.policies[0]?.sourcePath,
			manifest.automations[0]?.sourcePath,
			manifest.envoys[0]?.sourcePath,
			manifest.integrations[0]?.sourcePath,
			manifest.remotes?.[0]?.sourcePath,
			manifest.environment?.[0]?.sourcePath
		]).not.toContain(undefined);
		expect(manifestDestinationHref(manifest.apps[0]!.destination!)).toBe('/app/jobs');
		expect(manifestDestinationHref(manifest.collections[0]!.destination!)).toBeNull();
		expect(workspaceEnvoys(manifest)[0]?.destination).toEqual({
			kind: 'system',
			surface: 'envoys',
			selection: 'support'
		});
		expect(hookSummaryKey('mutate.prepare')).toBe('bolt.studio.hook.mutatePrepare');
		expect(integrationBindingSummary(manifest.integrations[0]!.bindings![0]!)).toBe(
			'GET /jobs · 0 * * * *'
		);
	});

	it('fails an older projection closed without exposing partial manifest navigation', () => {
		const olderManifest = Schema.decodeUnknownSync(ManifestSchema)({
			name: 'Workspace',
			version: '1',
			collections: [],
			apps: [],
			policies: [],
			automations: [],
			envoys: [],
			integrations: [],
			principals: [],
			requiredFacilities: []
		});

		expect(manifestInspectionState(olderManifest)).toBe('rebuild_required');
		expect(manifestSections(olderManifest)).toEqual([]);
	});

	it('rejects a current authored projection that omits its compiler-owned source path', () => {
		expect(() =>
			Schema.decodeUnknownSync(ManifestSchema)({
				name: 'Workspace',
				version: '1',
				compiledManifestVersion: COMPILED_MANIFEST_VERSION,
				collections: [
					{
						name: 'jobs',
						history: false,
						origin: 'authored',
						fields: [],
						relations: []
					}
				],
				apps: [],
				policies: [],
				automations: [],
				envoys: [],
				integrations: [],
				principals: [],
				requiredFacilities: []
			})
		).toThrow(/missing authored source paths/);
	});

	it('formats only the host-provided monetary estimate', () => {
		expect(formatMicroSgd(1_250_000)).toContain('1.25');
	});
});

describe('workspace navigation sections', () => {
	it('gives workbench diagnosis only; Changes and Live own the bundle furniture', () => {
		expect(studioTabOwnership('workbench')).toEqual({
			manifest: false,
			logs: false,
			lifecycle: false,
			diagnosis: true
		});
		expect(studioTabOwns('workbench', 'manifest')).toBe(false);
		expect(studioTabOwns('workbench', 'logs')).toBe(false);
		expect(studioTabOwns('workbench', 'lifecycle')).toBe(false);
		expect(studioTabOwns('changes', 'manifest')).toBe(true);
		expect(studioTabOwns('changes', 'logs')).toBe(true);
		expect(studioTabOwns('changes', 'lifecycle')).toBe(true);
		expect(studioTabOwns('changes', 'diagnosis')).toBe(false);
		expect(studioTabOwns('live', 'manifest')).toBe(true);
		expect(studioTabOwns('live', 'logs')).toBe(true);
		expect(studioTabOwns('live', 'lifecycle')).toBe(false);
		expect(studioTabOwns('live', 'diagnosis')).toBe(false);
	});

	it('names the workbench diff baseline from tracking, and the Changes Files lens from baseCommit', () => {
		expect(workbenchDiffBaselineKey('live')).toBe('bolt.studio.diff.againstLive');
		expect(workbenchDiffBaselineKey(undefined)).toBe('bolt.studio.diff.againstLive');
		expect(workbenchDiffBaselineKey('review-1')).toBe('bolt.studio.diff.againstMrHead');
		expect(CHANGES_DIFF_BASELINE_KEY).toBe('bolt.studio.diff.againstBase');
	});

	it('counts commits on the tracked MR that the worktree does not yet have', () => {
		const commits = [
			{ commit: 'c1', by: 'a', at: '2026-09-01T00:00:00.000Z', message: 'one' },
			{ commit: 'c2', by: 'b', at: '2026-09-01T01:00:00.000Z', message: 'two' },
			{ commit: 'c3', by: 'b', at: '2026-09-01T02:00:00.000Z', message: 'three' }
		];
		const mergeRequests = [request({ commits, head: 'c3' })];
		expect(
			newCommitsBehindHead({
				sourceCommit: 'c1',
				tracking: 'review-1',
				mergeRequests
			})
		).toBe(2);
		expect(
			newCommitsBehindHead({
				sourceCommit: 'c3',
				tracking: 'review-1',
				mergeRequests
			})
		).toBe(0);
		expect(
			newCommitsBehindHead({
				sourceCommit: 'c1',
				tracking: 'live',
				mergeRequests
			})
		).toBe(0);
	});

	it('marks local workbench files and dots dirty ancestors without inventing a lifecycle', () => {
		const drafts = { 'src/app.ts': 'changed', 'src/new.ts': 'added', 'gone.ts': '' };
		const sourceFiles = { 'src/app.ts': 'old', 'gone.ts': 'was' };
		expect(sourceFileMark('src/app.ts', drafts, sourceFiles)).toBe('M');
		expect(sourceFileMark('src/new.ts', drafts, sourceFiles)).toBe('A');
		expect(sourceFileMark('gone.ts', drafts, sourceFiles)).toBe('D');
		expect(sourceFileMark('src/app.ts', {}, sourceFiles)).toBeUndefined();
		expect(sourceTreeEntryBadge({ type: 'directory', path: 'src' }, drafts, sourceFiles)).toEqual({
			label: '·'
		});
		expect(sourceTreeEntryBadge({ type: 'file', path: 'src/app.ts' }, drafts, sourceFiles)).toMatchObject({
			label: 'M'
		});
	});

	it('keeps diagnosis on the workbench and the bound triple on the MR', () => {
		expect(workbenchDiagnosisState({ diagnosis: null, draftCount: 0 })).toBe('missing');
		expect(
			workbenchDiagnosisState({
				diagnosis: request().diagnosis,
				draftCount: 1
			})
		).toBe('stale');
		expect(
			workbenchDiagnosisState({
				diagnosis: { ...request().diagnosis, errors: 2 },
				draftCount: 0
			})
		).toBe('errors');
		expect(workbenchDiagnosisState({ diagnosis: request().diagnosis, draftCount: 0 })).toBe('clean');
		expect(boundTriple(request())).toEqual({
			commit: 'candidate-commit',
			bundle: 'artifact-2',
			fork: 'preview-1'
		});
		expect(canWorkOnMergeRequest(request(), 'live')).toBe(true);
		expect(canWorkOnMergeRequest(request(), 'review-1')).toBe(false);
	});

	it('lists Live releases from routed history, not the workbench', () => {
		const build = request().buildReceipt;
		const deploy = [{ at: '2026-09-02T00:00:00.000Z', level: 'log', line: 'guest-ok' }];
		expect(
			liveReleaseTimeline({
				entries: [
					{
						tenantId: 't',
						environmentId: 'live',
						releaseId: 'release-live',
						artifactId: 'artifact-live',
						ownerEpoch: '1'
					}
				],
				deploymentHistory: ['release-old', 'release-live'],
				releases: [
					{ releaseId: 'release-old', deployLog: [] },
					{ releaseId: 'release-live', buildLog: build, deployLog: deploy }
				],
				mergeRequests: [],
				tracking: 'live'
			} as unknown as HostSnapshot)
		).toEqual([
			{
				releaseId: 'release-live',
				artifactId: 'artifact-live',
				current: true,
				build,
				deploy
			},
			{
				releaseId: 'release-old',
				artifactId: undefined,
				current: false,
				build: undefined,
				deploy: []
			}
		]);
	});

	it('reads build and deploy logs from the tracked MR or a release, never a workbench buffer', () => {
		expect(evidenceLogs(undefined)).toEqual({ build: undefined, deploy: [] });
		const build = request().buildReceipt;
		const deploy = [{ at: '2026-09-02T00:00:00.000Z', level: 'log', line: 'guest-ok' }];
		const snapshot = {
			tracking: 'review-1',
			mergeRequests: [request({ deployLog: deploy })],
			releases: [],
			entries: []
		} as unknown as HostSnapshot;
		expect(evidenceLogs(snapshot)).toEqual({ build, deploy });
		expect(evidenceLogs({ ...snapshot, tracking: 'live' } as unknown as HostSnapshot)).toEqual({
			build,
			deploy
		});
		expect(
			evidenceLogs({
				tracking: 'live',
				mergeRequests: [request({ state: 'merged', deployLog: [] })],
				releases: [{ releaseId: 'release-live', buildLog: build, deployLog: deploy }],
				entries: [{ tenantId: 't', environmentId: 'live', releaseId: 'release-live', artifactId: 'a', ownerEpoch: '1' }]
			} as unknown as HostSnapshot)
		).toEqual({ build, deploy });
	});

	it('keeps the shell runtime structurally capable of mounting the one Automations surface', () => {
		expectTypeOf<AgentRuntimeConfig['client']>().toMatchTypeOf<AutomationRunsClient>();
	});

	it('groups operations before administration and keeps Automations deep links stable', () => {
		const system = buildSystemNavigation({
			isAdmin: true,
			canAccessAutomations: true,
			currentPath: AUTOMATIONS_PATH,
			i18n: { has: () => true, t: (key) => `translated:${key}` },
			plugins: [
				{
					key: 'workspace-studio',
					label: 'Workspace Studio',
					icon: 'product:studio',
					entry: '/__host/workspace-studio',
					placement: 'administration',
					adminOnly: true
				}
			]
		});
		const sections = buildWorkspaceNavigationSections({
			system,
			applications: [],
			i18n: { has: () => true, t: (key) => `translated:${key}` }
		});

		expect(sections.map((section) => section.key)).toEqual(['operations', 'administration']);
		expect(sections[0]?.items.map((item) => item.key)).toEqual(['approvals', 'automations']);
		expect(automationsHref('daily close')).toBe('/automations?automation=daily+close');
	});
});
