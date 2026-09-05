<script lang="ts">
	import { onMount } from 'svelte';
	import { Effect, Schema } from 'effect';
	import { getErrorMessage, toError } from '@norbital-ai/std';
	import Icon from '@iconify/svelte';
	import DiagnosisPane from './diagnosis-pane.svelte';
	import DocumentationPane from './documentation-pane.svelte';
	import DocumentationTree from './documentation-tree.svelte';
	import LivePane from './live-pane.svelte';
	import LiveSidebar from './live-sidebar.svelte';
	import ReviewPane from './review-pane.svelte';
	import ReviewSidebar from './review-sidebar.svelte';
	import SourceEditor from './source-editor.svelte';
	import SourceTree from './source-tree.svelte';
	import WorkbenchToolbar from './workbench-toolbar.svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Bound, Cluster, Cover, Inline, INSET_X_CLASS, Stack } from '@norbital-ai/ui/layout';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { workspaceSession } from '#lib/client/session.js';
	import { manifestDestinationHref } from '#lib/client/ui/shell/workspace-navigation.js';
	import {
		settleSourceCommit,
		sourceCommitFiles,
		sourceDraftValue,
		updateSourceDrafts,
		type SourceDrafts
	} from '#lib/client/ui/studio/source-drafts.js';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
	import {
		canRestoreRelease,
		currentRoutedRelease,
		HostSnapshotSchema,
		isStudioRootTab,
		liveReleaseTimeline,
		manifestSections,
		newCommitsBehindHead,
		releaseControls,
		workbenchDiffBaselineKey,
		workspaceEnvoys,
		type ChangesView,
		type HostSnapshot,
		type ManifestDestination,
		type StudioRootTab
	} from '#lib/client/ui/studio/studio-state.js';
	import {
		applyAuthoringLiveEvent,
		authoringJobBusy,
		authoringLiveJobMessageKey,
		authoringLivePhaseMessageKey,
		emptyAuthoringLiveState,
		openAuthoringLiveStream,
		type AuthoringLiveState
	} from '#lib/client/ui/studio/authoring-live.js';
	import {
		selectedWorkspaceDocumentationPath,
		workspaceDocumentationPages
	} from './workspace-documentation.js';

	let {
		client,
		onnavigate,
		initialSource
	}: {
		client: WorkspaceClient;
		onnavigate?: ((href: string) => void) | undefined;
		initialSource?: string | undefined;
	} = $props();
	const i18n = useI18n();
	const { t } = i18n;
	const queryMessage = (error: unknown): string | undefined =>
		error === undefined ? undefined : getErrorMessage(error);

	let snapshot = $state<HostSnapshot | undefined>();
	let view = $state<{
		rootTab: StudioRootTab;
		documentation: string;
		changes: ChangesView;
		file: string;
		manifestSection: string;
	}>({
		rootTab: 'documentation',
		documentation: '',
		changes: 'manifest',
		file: '',
		manifestSection: 'collections'
	});
	let editor = $state({ path: '', value: '' });
	let sourceDrafts = $state<SourceDrafts>({});
	let browserReady = $state(false);
	const manifestQuery = $derived(
		browserReady ? client.system.workspace.authoringManifest({}) : undefined
	);
	const workspace = $derived({
		manifest: manifestQuery?.current,
		error: queryMessage(manifestQuery?.error)
	});
	const environmentQuery = $derived(browserReady ? client.system.secrets.status({}) : undefined);
	const vault = $derived({
		entries: environmentQuery?.current ?? [],
		error: queryMessage(environmentQuery?.error)
	});
	let host = $state({ status: 'Loading workspace state…', busy: false });
	let live = $state<AuthoringLiveState>(emptyAuthoringLiveState());
	let selectedRequestId = $state<string | undefined>();
	let selectedReleaseId = $state<string | undefined>();
	let navigatorSheetOpen = $state(false);

	const session = workspaceSession();
	const rootTabs = $derived([
		{ name: 'documentation', label: t('bolt.studio.documentation'), content: '' },
		{ name: 'workbench', label: t('bolt.studio.workbench'), content: '' },
		{ name: 'changes', label: t('bolt.studio.changes'), content: '' },
		{ name: 'live', label: t('bolt.studio.live'), content: '' }
	] satisfies TabConfig[]);
	const sections = $derived(manifestSections(workspace.manifest, vault.entries));
	const sourceFiles = $derived(snapshot?.source.files ?? {});
	const files = $derived(Object.keys(sourceFiles).sort());
	const documentationPages = $derived(workspaceDocumentationPages(sourceFiles, i18n.locale));
	const documentationPath = $derived(
		selectedWorkspaceDocumentationPath(documentationPages, view.documentation)
	);
	const documentationContent = $derived(
		documentationPath === '' ? '' : sourceDraftValue(sourceDrafts, sourceFiles, documentationPath)
	);
	const fileSizes = $derived(
		Object.fromEntries(
			Object.entries(sourceFiles).map(([path, contents]) => [path, contents.length])
		)
	);
	const envoys = $derived(workspaceEnvoys(workspace.manifest));
	const currentRelease = $derived(currentRoutedRelease(snapshot?.entries ?? []));
	const controls = $derived(
		releaseControls({
			busy: host.busy || snapshot === undefined,
			hasRelease: currentRelease !== undefined
		})
	);
	const isDocumentation = $derived(view.rootTab === 'documentation');
	const isWorkbench = $derived(view.rootTab === 'workbench');
	const isChanges = $derived(view.rootTab === 'changes');
	const isLive = $derived(view.rootTab === 'live');
	const currentReleaseId = $derived(currentRelease?.releaseId);
	const sourceDraftCount = $derived(Object.keys(sourceDrafts).length);
	const tracking = $derived(snapshot?.tracking ?? 'live');
	const baselineKey = $derived(workbenchDiffBaselineKey(tracking));
	const newCommits = $derived(
		newCommitsBehindHead({
			sourceCommit: snapshot?.source.commit,
			tracking,
			mergeRequests: snapshot?.mergeRequests ?? []
		})
	);
	const updateRequired = $derived(snapshot?.needsRebase === true || newCommits > 0);
	const releases = $derived(liveReleaseTimeline(snapshot));
	const activeReleaseId = $derived(
		selectedReleaseId ??
			releases.find((release) => release.current)?.releaseId ??
			releases[0]?.releaseId
	);
	const selectedRelease = $derived(
		releases.find((release) => release.releaseId === activeReleaseId)
	);
	const canRestore = $derived(
		canRestoreRelease({
			busy: host.busy || snapshot === undefined,
			selected: selectedRelease
		})
	);
	const editorDirty = $derived(Object.hasOwn(sourceDrafts, editor.path));
	const liveWorking = $derived.by(() => {
		if (live.job === null) return undefined;
		return t('bolt.studio.live.working', {
			job: t(authoringLiveJobMessageKey(live.job.action)),
			phase: t(authoringLivePhaseMessageKey(live.job.phase))
		});
	});
	const hostStatusAnnouncement = $derived.by(() => {
		if (liveWorking !== undefined && (host.busy || authoringJobBusy(live))) return liveWorking;
		const { status } = host;
		if (status === 'Ready') return t('bolt.studio.status.ready');
		if (status.startsWith('Loading')) return t('bolt.studio.status.loading');
		if (status.startsWith('Failed:'))
			return t('bolt.studio.status.failedWithMessage', {
				message: status.slice('Failed:'.length).trim()
			});
		if (status.startsWith('Unavailable:'))
			return t('bolt.studio.status.unavailableWithMessage', {
				message: status.slice('Unavailable:'.length).trim()
			});
		if (status.startsWith('Migration ready')) return t('bolt.studio.status.migrationReady');
		if (status.startsWith('Resolve '))
			return t('bolt.studio.status.resolveConflicts', { count: snapshot?.conflicts.length ?? 1 });
		return status;
	});
	const navigatorDescriptionKey = $derived.by(() => {
		if (isDocumentation) return 'bolt.studio.navigatorDocumentationDescription' as const;
		if (isWorkbench) return 'bolt.studio.navigatorWorkbenchDescription' as const;
		if (isChanges) return 'bolt.studio.navigatorChangesDescription' as const;
		return 'bolt.studio.navigatorLiveDescription' as const;
	});

	let openedInitialSource = $state(false);
	const openSource = (path: string): void => {
		if (path === '') return;
		view.rootTab = 'workbench';
		view.file = path;
		editor = { path, value: sourceDraftValue(sourceDrafts, sourceFiles, path) };
	};

	const openDocumentation = (path: string): void => {
		view.rootTab = 'documentation';
		view.documentation = path;
	};

	const updateEditor = (value: string): void => {
		if (editor.path === '') return;
		sourceDrafts = updateSourceDrafts(sourceDrafts, sourceFiles, editor.path, value);
		editor = { ...editor, value };
	};

	const openDestination = (destination: ManifestDestination): void => {
		const href = manifestDestinationHref(destination);
		if (href !== null) onnavigate?.(href);
	};

	const actions = {
		readHostState: (sourceChange = false): Effect.Effect<void> =>
			Effect.gen(function* () {
				const raw = yield* Effect.tryPromise({
					try: () => session.operations.read(),
					catch: toError
				});
				const next = yield* Schema.decodeUnknownEffect(HostSnapshotSchema)(raw);
				if (sourceChange && Object.keys(sourceDrafts).length > 0) {
					host.status = t('bolt.studio.sourceChangedWithDrafts');
					return;
				}
				snapshot = next;
				if (sourceChange && editor.path !== '')
					editor = {
						...editor,
						value: sourceDraftValue(sourceDrafts, next.source.files, editor.path)
					};
				host.status = 'Ready';
				if (!openedInitialSource && initialSource !== undefined && initialSource.trim() !== '') {
					openedInitialSource = true;
					openSource(initialSource);
				}
			}).pipe(
				Effect.catch((cause) => {
					const message = String(cause);
					host.status = message.includes('trusted Colony routing headers are required')
						? message
						: `Unavailable: ${message}`;
					return Effect.void;
				})
			),
		operation: (
			body: Schema.Json,
			describe: () => string,
			afterSuccess?: () => void,
			afterFailure?: (message: string) => void
		): Effect.Effect<void> =>
			Effect.gen(function* () {
				host.busy = true;
				yield* Effect.tryPromise({ try: () => session.operations.run(body), catch: toError });
				host.status = describe();
				yield* actions.readHostState();
				afterSuccess?.();
			}).pipe(
				Effect.catch((cause) => {
					const message = getErrorMessage(cause);
					return actions.readHostState().pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (afterFailure === undefined) host.status = `Failed: ${message}`;
								else afterFailure(message);
							})
						)
					);
				}),
				Effect.ensuring(Effect.sync(() => (host.busy = false)))
			),
		requestReview: (requestId: string) =>
			actions.operation({ action: 'merge_request', operation: 'ready', requestId }, () =>
				t('bolt.studio.action.sentReview')
			),
		reviewPreview: (requestId: string) =>
			actions.operation(
				{ action: 'preview', operation: 'review', requestId },
				() => t('bolt.studio.action.openedReviewedPreview'),
				() => window.location.reload()
			),
		approveRelease: (requestId: string) =>
			actions.operation({ action: 'merge_request', operation: 'approve', requestId }, () =>
				t('bolt.studio.action.approvedRelease')
			),
		requestReleaseChanges: (requestId: string, reason: string) =>
			actions.operation(
				{ action: 'merge_request', operation: 'request_changes', requestId, reason },
				() => t('bolt.studio.action.requestedChanges')
			),
		rejectRelease: (requestId: string, reason: string) =>
			actions.operation({ action: 'merge_request', operation: 'reject', requestId, reason }, () =>
				t('bolt.studio.action.rejectedReview')
			),
		commentReview: (requestId: string, body: string) =>
			actions.operation({ action: 'merge_request', operation: 'comment', requestId, body }, () =>
				t('bolt.studio.action.commented')
			),
		rollback: (releaseId?: string) =>
			actions.operation(
				releaseId === undefined ? { action: 'rollback' } : { action: 'rollback', releaseId },
				() => t('bolt.studio.action.rolledBack')
			),
		diagnose: () =>
			actions.operation({ action: 'diagnose' }, () => t('bolt.studio.action.diagnosed')),
		switchWorkbench: (to: 'live' | string) =>
			actions.operation({ action: 'workbench', operation: 'switch', to }, () =>
				t('bolt.studio.action.switched')
			),
		workOn: (requestId: string) =>
			actions.operation(
				{ action: 'workbench', operation: 'switch', to: requestId },
				() => t('bolt.studio.action.switched'),
				() => {
					view.rootTab = 'workbench';
				}
			),
		updateWorkbench: () => {
			const requestId = tracking === 'live' ? undefined : tracking;
			if (requestId !== undefined && newCommits > 0) {
				return actions.operation({ action: 'merge_request', operation: 'update', requestId }, () =>
					t('bolt.studio.action.updated')
				);
			}
			return actions.operation(
				{ action: 'workbench', operation: 'rebase' },
				() => t('bolt.studio.action.rebased'),
				undefined,
				(message) => {
					const first = snapshot?.conflicts[0];
					if (first === undefined) {
						host.status = `Failed: ${message}`;
						return;
					}
					host.status = `Resolve ${snapshot?.conflicts.length ?? 1} conflicted file${
						(snapshot?.conflicts.length ?? 1) === 1 ? '' : 's'
					}, then Rebase again.`;
					openSource(first);
				}
			);
		},
		publish: () => {
			const committedFiles = sourceCommitFiles(sourceDrafts);
			return Effect.gen(function* () {
				host.busy = true;
				if (Object.keys(committedFiles).length > 0) {
					yield* Effect.tryPromise({
						try: () =>
							session.operations.run({
								action: 'source',
								expectedCommit: snapshot?.source.commit ?? '',
								files: committedFiles
							}),
						catch: toError
					});
					sourceDrafts = settleSourceCommit(sourceDrafts, committedFiles);
					yield* actions.readHostState();
				}
				yield* Effect.tryPromise({
					try: () => session.operations.run({ action: 'diagnose' }),
					catch: toError
				});
				yield* Effect.tryPromise({
					try: () => session.operations.run({ action: 'publish' }),
					catch: toError
				});
				host.status = t('bolt.studio.action.published');
				yield* actions.readHostState();
				window.location.reload();
			}).pipe(
				Effect.catch((cause) => {
					const message = getErrorMessage(cause);
					return actions.readHostState().pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (message.includes('DDL was generated')) {
									host.status = 'Migration ready — review or edit it, then Publish again.';
									const migration = Object.keys(snapshot?.source.files ?? {})
										.filter(
											(path) =>
												path.startsWith('.norbital/migrations/') && path.endsWith('/migration.sql')
										)
										.sort()
										.at(-1);
									if (migration !== undefined) openSource(migration);
								} else {
									host.status = `Failed: ${message}`;
								}
							})
						)
					);
				}),
				Effect.ensuring(Effect.sync(() => (host.busy = false)))
			);
		}
	};

	onMount(() => {
		browserReady = true;
		Effect.runFork(actions.readHostState());
		return openAuthoringLiveStream({
			url: session.authoringStreamUrl,
			tenantId: session.tenantId,
			onEvent: (event) => {
				live = applyAuthoringLiveEvent(live, event);
				if (
					event.kind === 'source' &&
					event.workspaceKey === snapshot?.source.workspaceKey &&
					event.commit !== snapshot.source.commit
				) {
					Effect.runFork(actions.readHostState(true));
				}
			}
		});
	});
</script>

{#snippet navigator()}
	{#if isDocumentation}
		<DocumentationTree
			pages={documentationPages}
			{sourceFiles}
			selectedPath={documentationPath}
			onselect={openDocumentation}
		/>
	{:else if isWorkbench}
		<SourceTree
			{files}
			{fileSizes}
			{sourceFiles}
			drafts={sourceDrafts}
			selected={view.file === '' ? '' : `source:${view.file}`}
			onselect={(key) => {
				if (key.startsWith('source:')) openSource(key.slice('source:'.length));
				navigatorSheetOpen = false;
			}}
		/>
	{:else if isChanges}
		<ReviewSidebar
			requests={snapshot?.mergeRequests ?? []}
			{selectedRequestId}
			{currentReleaseId}
			onselect={(requestId) => {
				selectedRequestId = requestId;
				navigatorSheetOpen = false;
			}}
		/>
	{:else}
		<LiveSidebar
			{releases}
			selectedReleaseId={activeReleaseId}
			onselect={(releaseId) => {
				selectedReleaseId = releaseId;
				navigatorSheetOpen = false;
			}}
		/>
	{/if}
{/snippet}

<Cover class="relative bg-background" gap="none">
	{#snippet top()}
		<Stack gap="md" shrink={false} class="bg-background px-4 pt-3 sm:gap-6 sm:px-6 sm:pt-6">
			<Stack as="header" gap="xs">
				<h1 class="text-heading">{t('bolt.studio.title')}</h1>
				<p class="hidden max-w-2xl text-meta sm:block">
					{t('bolt.studio.description')}
				</p>
			</Stack>
			<Cluster gap="sm" align="center" shrink={false}>
				<Tabs
					value={view.rootTab}
					onValueChange={(next) => {
						if (isStudioRootTab(next)) view.rootTab = next;
					}}
					showContent={false}
					animate={false}
					variant="default"
					layout="responsive"
					class="min-w-0 flex-1 !shrink"
					listClass="mx-0 w-full"
					config={rootTabs}
				/>
				<Button
					variant="ghost"
					size="sm"
					class="shrink-0 gap-2 md:hidden"
					aria-label={t('bolt.studio.openNavigator')}
					onclick={() => (navigatorSheetOpen = true)}
				>
					<Icon icon="lucide:panel-bottom" class="size-4" />
					{t('bolt.studio.browse')}
				</Button>
			</Cluster>
		</Stack>

		<Stack gap="none" shrink={false} class="min-w-0 {INSET_X_CLASS}">
			<span class="sr-only" aria-live="polite" aria-atomic="true">{hostStatusAnnouncement}</span>
			{#if isWorkbench}
				<WorkbenchToolbar
					hostStatus={host.status}
					busy={host.busy}
					liveStatus={liveWorking}
					{tracking}
					requests={snapshot?.mergeRequests ?? []}
					principal={session.principal}
					{newCommits}
					{baselineKey}
					draftCount={sourceDraftCount}
					{updateRequired}
					updateDisabled={host.busy || snapshot === undefined}
					updateReason={(controls.reasonKey === undefined ? undefined : t(controls.reasonKey)) ??
						t('bolt.studio.updateReason.rebaseLatest')}
					publishDisabled={host.busy || snapshot === undefined || updateRequired}
					publishReason={(controls.reasonKey === undefined ? undefined : t(controls.reasonKey)) ??
						(updateRequired
							? t('bolt.studio.publishReason.updateFirst')
							: t('bolt.studio.publishReason.ready'))}
					onswitch={(to) => void Effect.runPromise(actions.switchWorkbench(to))}
					onpublish={() => void Effect.runPromise(actions.publish())}
					ondiagnose={() => void Effect.runPromise(actions.diagnose())}
					onupdate={() => void Effect.runPromise(actions.updateWorkbench())}
				/>
			{/if}
			{#if (isChanges || isLive) && workspace.error !== undefined}
				<Inline
					gap="xs"
					shrink={false}
					class="h-6 border-b border-destructive/30 bg-destructive/10 px-2 text-destructive"
					role="status"
					data-testid="studio-manifest-error"
				>
					<Icon icon="lucide:triangle-alert" class="size-3 shrink-0" />
					<span class="truncate text-xs leading-none">
						{t('bolt.studio.manifestUnavailableWithError', { error: workspace.error })}
					</span>
				</Inline>
			{/if}
		</Stack>
	{/snippet}

	<Inline align="stretch" gap="none" fill class="min-w-0 {INSET_X_CLASS}">
		<aside
			class="hidden w-72 shrink-0 border-r border-border/60 bg-card font-sans md:block"
			aria-label={t('bolt.studio.sidebar')}
		>
			<Stack gap="none" fill>
				{@render navigator()}
			</Stack>
		</aside>

		<Bound
			size="full"
			grow
			clip
			class="relative min-w-0 bg-background font-sans"
			data-testid="studio-viewport"
		>
			{#if isDocumentation}
				<DocumentationPane
					selectedPath={documentationPath}
					content={documentationContent}
					pages={documentationPages}
					{sourceFiles}
					onselect={openDocumentation}
					onopenSource={openSource}
				/>
			{:else if isChanges}
				<ReviewPane
					releaseRequests={snapshot?.mergeRequests ?? []}
					{selectedRequestId}
					{currentReleaseId}
					busy={host.busy}
					comments={live.comments}
					canDecide={snapshot?.capabilities.canDecideReview === true}
					failure={host.status.startsWith('Failed:') ||
					host.status.startsWith('Unavailable:') ||
					host.status.includes('trusted Colony routing headers are required')
						? host.status
						: undefined}
					{tracking}
					changesView={view.changes}
					manifest={workspace.manifest}
					loading={!browserReady || (manifestQuery?.loading ?? false)}
					{sections}
					{envoys}
					selectedManifest={view.manifestSection}
					environment={vault.entries}
					environmentError={vault.error}
					liveLogs={live.logs}
					onview={(next) => (view.changes = next)}
					onpreview={(requestId) => void Effect.runPromise(actions.reviewPreview(requestId))}
					onapprove={(requestId) => void Effect.runPromise(actions.approveRelease(requestId))}
					onrequestchanges={(requestId, reason) =>
						void Effect.runPromise(actions.requestReleaseChanges(requestId, reason))}
					onreject={(requestId, reason) =>
						void Effect.runPromise(actions.rejectRelease(requestId, reason))}
					oncomment={(requestId, body) =>
						void Effect.runPromise(actions.commentReview(requestId, body))}
					onworkon={(requestId) => void Effect.runPromise(actions.workOn(requestId))}
					onready={(requestId) => void Effect.runPromise(actions.requestReview(requestId))}
					onopenSource={openSource}
					onopenDestination={openDestination}
					canOpenDestination={(destination: ManifestDestination) =>
						manifestDestinationHref(destination) !== null}
					onretry={() => window.location.reload()}
				/>
			{:else if isLive}
				<LivePane
					{releases}
					selectedReleaseId={activeReleaseId}
					busy={host.busy}
					{canRestore}
					manifest={workspace.manifest}
					loading={!browserReady || (manifestQuery?.loading ?? false)}
					{sections}
					{envoys}
					selectedManifest={view.manifestSection}
					environment={vault.entries}
					environmentError={vault.error}
					liveLogs={live.logs}
					onrestore={() => void Effect.runPromise(actions.rollback(selectedRelease?.releaseId))}
					onopenSource={openSource}
					onopenDestination={openDestination}
					canOpenDestination={(destination: ManifestDestination) =>
						manifestDestinationHref(destination) !== null}
					onretry={() => window.location.reload()}
				/>
			{:else}
				<Stack gap="none" fill class="min-h-0">
					<Bound size="full" grow clip class="min-h-0">
						<SourceEditor
							path={editor.path}
							value={editor.value}
							fileCount={files.length}
							{baselineKey}
							before={sourceFiles[editor.path] ?? null}
							dirty={editorDirty}
							onValueChange={updateEditor}
						/>
					</Bound>
					<DiagnosisPane
						diagnosis={snapshot?.diagnosis ?? null}
						draftCount={sourceDraftCount}
						busy={host.busy}
						onopenSource={openSource}
						onrerun={() => void Effect.runPromise(actions.diagnose())}
					/>
				</Stack>
			{/if}
		</Bound>
	</Inline>
</Cover>

<Sheet.Root bind:open={navigatorSheetOpen}>
	{#if navigatorSheetOpen}
		<Sheet.Content flush>
			<Sheet.Header class="shrink-0 border-b border-border px-4 py-3 pr-12">
				<Sheet.Title>{t('bolt.studio.navigator')}</Sheet.Title>
				<Sheet.Description>
					{t(navigatorDescriptionKey)}
				</Sheet.Description>
			</Sheet.Header>
			<Stack gap="none" grow class="min-h-0 bg-card">
				{@render navigator()}
			</Stack>
		</Sheet.Content>
	{/if}
</Sheet.Root>
