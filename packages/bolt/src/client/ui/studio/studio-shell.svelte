<script lang="ts">
	import { onMount } from 'svelte';
	import { Effect, Schema } from 'effect';
	import { getErrorMessage } from '@norbital-ai/std';
	import Icon from '@iconify/svelte';
	import ActivityPane from './activity-pane.svelte';
	import ManifestPane from './manifest-pane.svelte';
	import ManifestTree from './manifest-tree.svelte';
	import SourceEditor from './source-editor.svelte';
	import ReviewPane from './review-pane.svelte';
	import ReviewSidebar from './review-sidebar.svelte';
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
		currentRoutedRelease,
		HostSnapshotSchema,
		manifestSections,
		releaseControls,
		workspaceEnvoys,
		workbenchPreviewState,
		WorkbenchBuildReceiptSchema,
		type HostSnapshot,
		type ManifestDestination,
		type WorkbenchView,
		type StudioRootTab
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		client,
		onnavigate,
		initialSource
	}: {
		client: WorkspaceClient;
		onnavigate?: ((href: string) => void) | undefined;
		initialSource?: string | undefined;
	} = $props();
	const { t } = useI18n();
	const queryMessage = (error: unknown): string | undefined =>
		error === undefined ? undefined : getErrorMessage(error);

	const PreviewBuildResponseSchema = Schema.Struct({
		preview: Schema.Struct({ receipt: WorkbenchBuildReceiptSchema })
	});

	let snapshot = $state<HostSnapshot | undefined>();
	let view = $state<{
		rootTab: StudioRootTab;
		workbench: WorkbenchView;
		selected: string;
		expanded: ReadonlyArray<string>;
	}>({
		rootTab: 'workbench',
		workbench: 'manifest',
		selected: 'collections',
		expanded: ['collections']
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
	let selectedRequestId = $state<string | undefined>();
	let navigatorSheetOpen = $state(false);
	let activitySheetOpen = $state(false);
	let latestBuildReceipt = $state<HostSnapshot['buildReceipt']>();
	let previewNowEpochMs = $state(Date.now());
	$effect(() => {
		const expiresAt = snapshot?.preview?.expiresAtEpochMs;
		if (expiresAt === undefined || expiresAt <= previewNowEpochMs) return;
		const timeout = window.setTimeout(
			() => (previewNowEpochMs = Date.now()),
			Math.min(expiresAt - previewNowEpochMs + 1, 2_147_483_647)
		);
		return () => window.clearTimeout(timeout);
	});

	const session = workspaceSession();
	const rootTabs = $derived([
		{ name: 'workbench', label: t('bolt.studio.workbench'), content: '' },
		{ name: 'review', label: t('bolt.studio.reviews'), content: '' }
	] satisfies TabConfig[]);
	const sections = $derived(manifestSections(workspace.manifest, vault.entries));
	const sourceFiles = $derived(snapshot?.source.files ?? {});
	const files = $derived(Object.keys(sourceFiles).sort());
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
	const isWorkbench = $derived(view.rootTab === 'workbench');
	const isReview = $derived(view.rootTab === 'review');
	const currentReleaseId = $derived(currentRelease?.releaseId);
	const buildReceipt = $derived(latestBuildReceipt ?? snapshot?.buildReceipt);
	const sourceDraftCount = $derived(Object.keys(sourceDrafts).length);
	const previewState = $derived(
		workbenchPreviewState({
			preview: snapshot?.preview,
			sourceCommit: snapshot?.source.commit,
			nowEpochMs: previewNowEpochMs
		})
	);
	const openReviewForCurrentCommit = $derived(
		(snapshot?.releaseRequests ?? []).find(
			(request) =>
				request.commit === snapshot?.source.commit &&
				(request.status === 'open' || request.status === 'approving')
		)
	);
	const currentCommitAlreadyRequested = $derived(openReviewForCurrentCommit !== undefined);
	const requestReviewDisabled = $derived(
		!controls.canRequestReview ||
			sourceDraftCount > 0 ||
			previewState !== 'current' ||
			currentCommitAlreadyRequested
	);
	const requestReviewReason = $derived(
		(controls.reasonKey === undefined ? undefined : t(controls.reasonKey)) ??
			(sourceDraftCount > 0
				? t('bolt.studio.reviewReason.saveDrafts')
				: previewState !== 'current'
					? t('bolt.studio.reviewReason.buildPreview')
					: currentCommitAlreadyRequested
						? t('bolt.studio.reviewReason.alreadyRequested')
						: t('bolt.studio.reviewReason.sendExact'))
	);
	const hostStatusAnnouncement = $derived.by(() => {
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

	let openedInitialSource = $state(false);
	const openSource = (path: string): void => {
		if (path === '') return;
		view.workbench = 'editor';
		view.selected = `source:${path}`;
		editor = { path, value: sourceDraftValue(sourceDrafts, sourceFiles, path) };
	};

	const updateEditor = (value: string): void => {
		if (editor.path === '') return;
		sourceDrafts = updateSourceDrafts(sourceDrafts, sourceFiles, editor.path, value);
		editor = { ...editor, value };
	};

	const openCurrentReview = (): void => {
		selectedRequestId = openReviewForCurrentCommit?.id;
		view.rootTab = 'review';
	};

	const actions = {
		readHostState: (): Effect.Effect<void> =>
			Effect.gen(function* () {
				const raw = yield* Effect.tryPromise(() => session.operations.read());
				snapshot = yield* Schema.decodeUnknownEffect(HostSnapshotSchema)(raw);
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
				yield* Effect.tryPromise(() => session.operations.run(body));
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
		requestReview: () =>
			actions.operation(
				{ action: 'release_request', operation: 'open' },
				() => t('bolt.studio.action.sentReview'),
				() => {
					view.rootTab = 'review';
					selectedRequestId = snapshot?.releaseRequests.at(-1)?.id;
				}
			),
		reviewPreview: (requestId: string) =>
			actions.operation(
				{ action: 'preview', operation: 'review', requestId },
				() => t('bolt.studio.action.openedReviewedPreview'),
				() => window.location.reload()
			),
		approveRelease: (requestId: string) =>
			actions.operation({ action: 'release_request', operation: 'approve', requestId }, () =>
				t('bolt.studio.action.approvedRelease')
			),
		requestReleaseChanges: (requestId: string, reason: string) =>
			actions.operation(
				{ action: 'release_request', operation: 'request_changes', requestId, reason },
				() => t('bolt.studio.action.requestedChanges')
			),
		rejectRelease: (requestId: string, reason: string) =>
			actions.operation({ action: 'release_request', operation: 'reject', requestId, reason }, () =>
				t('bolt.studio.action.rejectedReview')
			),
		rollback: () =>
			actions.operation({ action: 'rollback' }, () => t('bolt.studio.action.rolledBack')),
		preview: () => {
			const committedFiles = sourceCommitFiles(sourceDrafts);
			return Effect.gen(function* () {
				host.busy = true;
				if (Object.keys(committedFiles).length > 0) {
					yield* Effect.tryPromise(() =>
						session.operations.run({
							action: 'source',
							expectedCommit: snapshot?.source.commit ?? '',
							files: committedFiles
						})
					);
					sourceDrafts = settleSourceCommit(sourceDrafts, committedFiles);
					yield* actions.readHostState();
				}
				const response = yield* Effect.tryPromise(() =>
					session.operations.run({ action: 'preview', operation: 'build' })
				);
				if (Schema.is(PreviewBuildResponseSchema)(response)) {
					latestBuildReceipt = response.preview.receipt;
				}
				host.status = t('bolt.studio.previewReady');
				yield* actions.readHostState();
				window.location.reload();
			}).pipe(
				Effect.catch((cause) => {
					const message = getErrorMessage(cause);
					return actions.readHostState().pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								if (message.includes('DDL was generated')) {
									host.status = 'Migration ready — review or edit it, then Preview again.';
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
		},
		openPreview: () =>
			actions.operation(
				{ action: 'preview', operation: 'build' },
				() => t('bolt.studio.action.openedPreview'),
				() => window.location.reload()
			),
		rebaseWorkbench: () =>
			actions.operation(
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
			)
	};

	onMount(() => {
		browserReady = true;
		Effect.runFork(actions.readHostState());
	});
</script>

{#snippet navigator()}
	{#if isWorkbench}
		<ManifestTree
			{sections}
			{files}
			{fileSizes}
			selected={view.selected}
			expanded={view.expanded}
			view={view.workbench}
			onselect={(key) => {
				view.selected = key;
				if (key.startsWith('source:')) {
					openSource(key.slice('source:'.length));
				}
				navigatorSheetOpen = false;
			}}
			ontoggle={(id) => {
				view.expanded = view.expanded.includes(id)
					? view.expanded.filter((candidate) => candidate !== id)
					: [...view.expanded, id];
			}}
		/>
	{:else}
		<ReviewSidebar
			requests={snapshot?.releaseRequests ?? []}
			{selectedRequestId}
			{currentReleaseId}
			onselect={(requestId) => {
				selectedRequestId = requestId;
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
						if (next === 'workbench' || next === 'review') view.rootTab = next;
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

		<Stack gap="none" shrink={false} class={INSET_X_CLASS}>
			<span class="sr-only" aria-live="polite" aria-atomic="true">{hostStatusAnnouncement}</span>
			{#if isWorkbench}
				<WorkbenchToolbar
					hostStatus={host.status}
					busy={host.busy}
					view={view.workbench}
					previewReady={sourceDraftCount === 0 && previewState === 'current'}
					draftCount={sourceDraftCount}
					currentCommit={snapshot?.source.commit}
					previewExpiresAt={previewState === 'current'
						? snapshot?.preview?.expiresAtEpochMs
						: undefined}
					previewExpired={previewState === 'expired'}
					buildFailed={buildReceipt?.outcome === 'failed'}
					updateRequired={snapshot?.needsRebase === true}
					updateDisabled={host.busy || snapshot === undefined}
					updateReason={(controls.reasonKey === undefined ? undefined : t(controls.reasonKey)) ??
						t('bolt.studio.updateReason.rebaseLatest')}
					previewDisabled={!controls.canPreview || snapshot?.needsRebase === true}
					previewReason={(controls.reasonKey === undefined ? undefined : t(controls.reasonKey)) ??
						(snapshot?.needsRebase === true
							? t('bolt.studio.previewReason.rebaseFirst')
							: t('bolt.studio.previewReason.ready'))}
					reviewRequested={currentCommitAlreadyRequested}
					reviewDisabled={requestReviewDisabled}
					reviewReason={requestReviewReason}
					onview={(next) => (view.workbench = next)}
					onpreview={() => void Effect.runPromise(actions.preview())}
					onopenpreview={() => void Effect.runPromise(actions.openPreview())}
					onreview={() => void Effect.runPromise(actions.requestReview())}
					onopenreview={openCurrentReview}
					onrebase={() => void Effect.runPromise(actions.rebaseWorkbench())}
					onactivity={() => (activitySheetOpen = true)}
				/>
			{/if}
			{#if isWorkbench && workspace.error !== undefined}
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

	<Inline align="stretch" gap="none" fill class={INSET_X_CLASS}>
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
			{#if isReview}
				<ReviewPane
					releaseRequests={snapshot?.releaseRequests ?? []}
					{selectedRequestId}
					{currentReleaseId}
					busy={host.busy}
					canDecide={snapshot?.capabilities.canDecideReview === true}
					failure={host.status.startsWith('Failed:') ||
					host.status.startsWith('Unavailable:') ||
					host.status.includes('trusted Colony routing headers are required')
						? host.status
						: undefined}
					onpreview={(requestId) => void Effect.runPromise(actions.reviewPreview(requestId))}
					onapprove={(requestId) => void Effect.runPromise(actions.approveRelease(requestId))}
					onrequestchanges={(requestId, reason) =>
						void Effect.runPromise(actions.requestReleaseChanges(requestId, reason))}
					onreject={(requestId, reason) =>
						void Effect.runPromise(actions.rejectRelease(requestId, reason))}
				/>
			{:else if view.workbench === 'manifest'}
				<ManifestPane
					manifest={workspace.manifest}
					loading={!browserReady || (manifestQuery?.loading ?? false)}
					{sections}
					{envoys}
					selected={view.selected}
					environment={vault.entries}
					environmentError={vault.error}
					onopenSource={openSource}
					onopenDestination={(destination: ManifestDestination) => {
						const href = manifestDestinationHref(destination);
						if (href !== null) onnavigate?.(href);
					}}
					canOpenDestination={(destination: ManifestDestination) =>
						manifestDestinationHref(destination) !== null}
					onretry={() => window.location.reload()}
				/>
			{:else}
				<SourceEditor
					path={editor.path}
					value={editor.value}
					fileCount={files.length}
					onValueChange={updateEditor}
				/>
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
					{t(
						isWorkbench
							? 'bolt.studio.navigatorWorkbenchDescription'
							: 'bolt.studio.navigatorReviewsDescription'
					)}
				</Sheet.Description>
			</Sheet.Header>
			<Stack gap="none" grow class="min-h-0 bg-card">
				{@render navigator()}
			</Stack>
		</Sheet.Content>
	{/if}
</Sheet.Root>

<Sheet.Root bind:open={activitySheetOpen}>
	{#if activitySheetOpen}
		<Sheet.Content flush side="right" class="w-[min(34rem,100%)] sm:max-w-[34rem]">
			<Sheet.Header class="shrink-0 border-b border-border px-4 py-3 pr-12 sm:px-5">
				<Sheet.Title>{t('bolt.studio.activity')}</Sheet.Title>
				<Sheet.Description>{t('bolt.studio.activityDescription')}</Sheet.Description>
			</Sheet.Header>
			<Stack gap="none" grow class="min-h-0 bg-background">
				<ActivityPane
					snapshot={snapshot}
					receipt={buildReceipt}
					hostStatus={host.status}
					{controls}
					onrollback={() => void Effect.runPromise(actions.rollback())}
				/>
			</Stack>
		</Sheet.Content>
	{/if}
</Sheet.Root>
