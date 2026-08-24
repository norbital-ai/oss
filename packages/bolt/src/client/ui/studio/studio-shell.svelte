<script lang="ts">
	import { onMount } from 'svelte';
	import { Effect, Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import OperationsPane from './operations-pane.svelte';
	import ManifestPane from './manifest-pane.svelte';
	import ManifestTree from './manifest-tree.svelte';
	import SourceEditor from './source-editor.svelte';
	import ReviewPane from './review-pane.svelte';
	import ReviewSidebar from './review-sidebar.svelte';
	import AuthoringToolbar from './authoring-toolbar.svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Bound, Cluster, Cover, Inline, INSET_X_CLASS, Stack } from '@norbital-ai/ui/layout';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { workspaceSession } from '#lib/client/session.js';
	import {
		settleSourceCommit,
		sourceCommitFiles,
		sourceDraftValue,
		updateSourceDrafts,
		type SourceDrafts
	} from '#lib/client/ui/studio/source-drafts.js';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
	import {
		manifestSections,
		releaseControls,
		studioEnvironments,
		unavailableFacilities,
		workspaceEnvoys,
		workspaceTools,
		type AuthoringView,
		type StudioReviewTab,
		type StudioRootTab
	} from '#lib/client/ui/studio/studio-state.js';

	/**
	 * Workspace Studio exposes one authoring path: personal Workbench → Preview → Review → Live.
	 * Runtime diagnostics remain a secondary administrator-only surface.
	 */

	/**
	 * The compiled workspace's own collection client, for the collection Data tab.
	 *
	 * Handed in rather than imported: only the workspace entry may name `$bolt/client`. It used to be
	 * fetched here with a dynamic `import('virtual:colony-client')` — a host-side module that
	 * resolved a workspace by reading the routed tenant off the document, which is how a Studio
	 * opened after a client-side organization switch could browse the previous tenant's data.
	 */
	let { client }: { client: WorkspaceClient } = $props();

	const OperationsStateSchema = Schema.Struct({
		capabilities: Schema.Struct({ canDecideReview: Schema.Boolean }),
		entries: Schema.Array(
			Schema.Struct({
				tenantId: Schema.String,
				environmentId: Schema.String,
				releaseId: Schema.String,
				artifactId: Schema.String,
				health: Schema.String,
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
		readiness: Schema.Struct({ accepting: Schema.Boolean, outstanding: Schema.Number }),
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
				changes: Schema.Array(
					Schema.Struct({
						path: Schema.NonEmptyString,
						before: Schema.NullOr(Schema.String),
						after: Schema.String
					})
				)
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
				changedFiles: Schema.Array(
					Schema.Struct({
						path: Schema.NonEmptyString,
						before: Schema.NullOr(Schema.String),
						after: Schema.String
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
		workbenches: Schema.Array(Schema.Struct({ workspaceKey: Schema.String, open: Schema.Boolean })),
		facilities: Schema.Array(Schema.Struct({ name: Schema.String, available: Schema.Boolean }))
	});
	type OperationsState = typeof OperationsStateSchema.Type;

	let snapshot = $state<OperationsState | undefined>();
	/**
	 * Where the reader is, held as one cell rather than six.
	 *
	 * The tab, the sub-views, the selected node, which branches are open and which environment is
	 * being read only ever change together in response to the same click, and splitting them into
	 * independent cells is what made a navigation change six separate writes.
	 */
	let view = $state<{
		rootTab: StudioRootTab;
		workbench: AuthoringView;
		review: StudioReviewTab;
		selected: string;
		expanded: ReadonlyArray<string>;
		environmentId: string | undefined;
	}>({
		rootTab: 'workbench',
		workbench: 'manifest',
		review: 'requests',
		selected: 'collections',
		expanded: ['collections'],
		environmentId: undefined
	});
	/** The file open in the Editor. Working copies live separately so switching files cannot lose one. */
	let editor = $state({ path: '', value: '' });
	/** Every source file changed against the host snapshot, committed together by Preview. */
	let sourceDrafts = $state<SourceDrafts>({});
	let browserReady = $state(false);
	const manifestQuery = $derived(browserReady ? client.system.workspace.manifest({}) : undefined);
	const workspace = $derived({
		manifest: manifestQuery?.current,
		error:
			manifestQuery?.error === undefined
				? undefined
				: manifestQuery.error instanceof Error
					? manifestQuery.error.message
					: String(manifestQuery.error)
	});
	const environmentQuery = $derived(browserReady ? client.system.secrets.status({}) : undefined);
	const vault = $derived({
		entries: environmentQuery?.current ?? [],
		error:
			environmentQuery?.error === undefined
				? undefined
				: environmentQuery.error instanceof Error
					? environmentQuery.error.message
					: String(environmentQuery.error)
	});
	/** The last thing the host said, and whether a command it was told to run is still running. */
	let host = $state({ status: 'Loading managed host state…', busy: false });
	/** The release request selected in Review; absent means the newest request. */
	let selectedRequestId = $state<string | undefined>();
	/**
	 * Whether the navigator is open as a sheet.
	 *
	 * The sidebar slot is `md:block`, so below that breakpoint the manifest tree and the review
	 * navigator have nowhere to be. Without this the whole left-hand column simply vanishes on a
	 * phone and no branch of the workspace can be reached at all.
	 */
	let navigatorSheetOpen = $state(false);

	/**
	 * Every Studio read is an ordinary authenticated Bolt command; nothing here queries tenant SQL.
	 *
	 * This was a fourth hand-rolled HTTP client — its own endpoint literal, its own credential read
	 * off the document — sitting beside three others that did the same job. The session declares one
	 * transport and one host operations seam, and this page uses exactly those.
	 */
	const session = workspaceSession();
	const rootTabs = $derived([
		{ name: 'workbench', label: 'Workbench', content: '' },
		{ name: 'review', label: 'Review', content: '' },
		...(snapshot?.capabilities.canDecideReview === true
			? [{ name: 'operations', label: 'Operations', content: '' }]
			: [])
	] satisfies TabConfig[]);
	const sections = $derived(manifestSections(workspace.manifest, vault.entries));
	const sourceFiles = $derived(snapshot?.source.files ?? {});
	const files = $derived(Object.keys(sourceFiles).sort());
	const fileSizes = $derived(
		Object.fromEntries(
			Object.entries(sourceFiles).map(([path, contents]) => [path, contents.length])
		)
	);
	const envoys = $derived(workspaceEnvoys(workspace.manifest, files));
	const tools = $derived(workspaceTools(files));
	const environments = $derived(studioEnvironments(snapshot?.entries ?? []));
	const activeEnvironment = $derived(
		environments.find((candidate) => candidate.id === view.environmentId) ?? environments[0]
	);
	const missingFacilities = $derived(unavailableFacilities(snapshot?.facilities ?? []));
	const controls = $derived(
		releaseControls({
			busy: host.busy,
			accepting: snapshot?.readiness.accepting ?? false,
			hasRelease: (activeEnvironment?.releaseId ?? '') !== ''
		})
	);
	const readOnly = false;
	const isWorkbench = $derived(view.rootTab === 'workbench');
	const isReview = $derived(view.rootTab === 'review');
	const isOperations = $derived(view.rootTab === 'operations');
	const sourceDraftCount = $derived(Object.keys(sourceDrafts).length);
	const currentCommitAlreadyRequested = $derived(
		(snapshot?.releaseRequests ?? []).some((request) => request.commit === snapshot?.source.commit)
	);
	const requestReviewDisabled = $derived(
		!controls.canRequestReview ||
			sourceDraftCount > 0 ||
			snapshot?.preview == null ||
			snapshot.preview.commit !== snapshot.source.commit ||
			currentCommitAlreadyRequested
	);
	const requestReviewReason = $derived(
		controls.reason ??
			(sourceDraftCount > 0
				? 'Preview saves every draft before Review.'
				: snapshot?.preview == null || snapshot.preview.commit !== snapshot?.source.commit
					? 'Build Preview for the current workbench first.'
					: currentCommitAlreadyRequested
						? 'This workbench commit is already in Review.'
						: 'Send this exact Preview to Review.')
	);

	/** Opens an authored file in the Editor; "View model" and "View source" both land here. */
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
		const request = [...(snapshot?.releaseRequests ?? [])]
			.reverse()
			.find((candidate) => candidate.commit === snapshot?.source.commit);
		selectedRequestId = request?.id;
		view.rootTab = 'review';
		view.review = 'requests';
	};

	const actions = {
		/**
		 * Reads host state once when Studio mounts and after a host operation succeeds. It deliberately
		 * does not claim `busy`, because the read itself does not block release controls.
		 */
		readHostState: (): Effect.Effect<void> =>
			Effect.gen(function* () {
				const raw = yield* Effect.tryPromise(() => session.operations.read());
				snapshot = yield* Schema.decodeUnknownEffect(OperationsStateSchema)(raw);
				host.status = snapshot.readiness.accepting ? 'Ready' : 'Draining';
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
					const message = cause instanceof Error ? cause.message : String(cause);
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
				() => 'Sent the exact Preview to Review',
				() => {
					view.rootTab = 'review';
					view.review = 'requests';
					selectedRequestId = snapshot?.releaseRequests.at(-1)?.id;
				}
			),
		reviewPreview: (requestId: string) =>
			actions.operation(
				{ action: 'preview', operation: 'review', requestId },
				() => 'Opened the exact Preview under Review',
				() => window.location.reload()
			),
		approveRelease: (requestId: string) =>
			actions.operation(
				{ action: 'release_request', operation: 'approve', requestId },
				() => 'Approved and released the exact reviewed Preview'
			),
		requestReleaseChanges: (requestId: string, reason: string) =>
			actions.operation(
				{ action: 'release_request', operation: 'request_changes', requestId, reason },
				() => 'Requested changes and retired that Preview'
			),
		rejectRelease: (requestId: string, reason: string) =>
			actions.operation(
				{ action: 'release_request', operation: 'reject', requestId, reason },
				() => 'Rejected the Review and retired that Preview'
			),
		rollback: () =>
			actions.operation({ action: 'rollback' }, () => 'Rolled back to the previous release'),
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
				yield* Effect.tryPromise(() =>
					session.operations.run({ action: 'preview', operation: 'build' })
				);
				host.status = 'Preview ready';
				yield* actions.readHostState();
				window.location.reload();
			}).pipe(
				Effect.catch((cause) => {
					const message = cause instanceof Error ? cause.message : String(cause);
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
		rebaseWorkbench: () =>
			actions.operation(
				{ action: 'workbench', operation: 'rebase' },
				() => 'Rebased onto the latest Live commit',
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

<!--
	One navigator, rendered into the fixed sidebar slot on md and up and into a sheet below it. Both
	mounts read the same `view` cell, so opening a branch from the sheet leaves the reader exactly
	where the sidebar would have.
-->
{#snippet navigator()}
	{#if isWorkbench}
		<ManifestTree
			{sections}
			{files}
			{fileSizes}
			selected={view.selected}
			expanded={view.expanded}
			view={view.workbench}
			{readOnly}
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
			onselect={(requestId) => {
				selectedRequestId = requestId;
				navigatorSheetOpen = false;
			}}
		/>
	{/if}
{/snippet}

<Cover class="relative bg-background" gap="none">
	{#snippet top()}
		<!-- Root navigation follows the product's page-heading rhythm: title, one line of what the
		     page is for, then the rail. -->
		<Stack gap="lg" shrink={false} class="bg-background px-4 pt-4 sm:px-6 sm:pt-6">
			<Stack as="header" gap="xs">
				<h1 class="text-heading">Workspace Studio</h1>
				<p class="max-w-2xl text-meta">
					Edit safely, preview the exact result, then ask for review.
				</p>
			</Stack>
			<Cluster gap="sm" align="center" shrink={false}>
				<Tabs
					value={view.rootTab}
					onValueChange={(next) => {
						if (next === 'workbench' || next === 'review' || next === 'operations') {
							view.rootTab = next;
						}
					}}
					showContent={false}
					animate={false}
					variant="default"
					layout="responsive"
					class="min-w-0 flex-1 !shrink"
					listClass="mx-0 w-full"
					config={rootTabs}
				/>
				{#if !isOperations}
					<Button
						variant="ghost"
						size="sm"
						class="shrink-0 gap-2 md:hidden"
						aria-label="Open the Workspace Studio navigator"
						onclick={() => (navigatorSheetOpen = true)}
					>
						<Icon icon="lucide:panel-bottom" class="size-4" />
						Browse
					</Button>
				{/if}
			</Cluster>
		</Stack>

		{#if !isOperations}
			<!-- The root rail and every nested tab surface share one page gutter. Keeping the gutter on
			     this parent prevents Workbench and Review from drifting independently. -->
			<Stack gap="none" shrink={false} class={INSET_X_CLASS}>
				{#if isWorkbench}
					<AuthoringToolbar
						hostStatus={host.status}
						view={view.workbench}
						previewReady={sourceDraftCount === 0 &&
							snapshot?.preview?.commit === snapshot?.source.commit}
						updateRequired={snapshot?.needsRebase === true}
						updateDisabled={host.busy || snapshot?.readiness.accepting !== true}
						updateReason={controls.reason ?? 'Rebase onto the latest Live commit.'}
						previewDisabled={!controls.canPreview || snapshot?.needsRebase === true}
						previewReason={controls.reason ??
							(snapshot?.needsRebase === true
								? 'Rebase onto Live before Preview.'
								: 'Preview is ready to build.')}
						reviewRequested={currentCommitAlreadyRequested}
						reviewDisabled={requestReviewDisabled}
						reviewReason={requestReviewReason}
						onview={(next) => (view.workbench = next)}
						onpreview={() => void Effect.runPromise(actions.preview())}
						onreview={() => void Effect.runPromise(actions.requestReview())}
						onopenreview={openCurrentReview}
						onrebase={() => void Effect.runPromise(actions.rebaseWorkbench())}
					/>
				{:else}
					<!-- Row 2b: Review chrome -->
					<Cluster
						gap="sm"
						align="center"
						shrink={false}
						class="border-b border-border/60 bg-card px-2 py-1.5"
						data-testid="studio-review-tabs"
					>
						<Tabs
							value={view.review}
							onValueChange={(next) => {
								if (next === 'requests' || next === 'history' || next === 'schema') {
									view.review = next;
								}
							}}
							showContent={false}
							animate={false}
							variant="underline"
							layout="horizontal"
							class="min-w-0 max-w-full !shrink"
							listClass="mx-0 w-fit max-w-full"
							config={[
								{ name: 'requests', label: 'Changes', content: '' },
								{ name: 'schema', label: 'Schema', content: '' },
								{ name: 'history', label: 'History', content: '' }
							] satisfies TabConfig[]}
						/>
					</Cluster>
				{/if}

				{#if isWorkbench && missingFacilities.length > 0}
					<Inline
						gap="xs"
						shrink={false}
						class="h-6 border-b border-border/60 px-2 text-muted-foreground"
						role="status"
						data-testid="studio-missing-facilities"
					>
						<Icon icon="lucide:plug" class="size-3 shrink-0" />
						<span class="truncate text-xs leading-none">
							Not configured: {missingFacilities.join(', ')}
						</span>
					</Inline>
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
							Workspace manifest unavailable: {workspace.error}
						</span>
					</Inline>
				{/if}
			</Stack>
		{/if}
	{/snippet}

	<!-- One page gutter for every root tab. -->
	<Inline align="stretch" gap="none" fill class={INSET_X_CLASS}>
		{#if isOperations}
			<Bound size="full" grow clip class="bg-background font-sans">
				<OperationsPane
					{snapshot}
					{controls}
					onrollback={() => void Effect.runPromise(actions.rollback())}
				/>
			</Bound>
		{:else}
			<aside
				class="hidden w-72 shrink-0 border-r border-border/60 bg-card font-sans md:block"
				aria-label="Workspace Studio sidebar"
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
						tab={view.review}
						releaseRequests={snapshot?.releaseRequests ?? []}
						{selectedRequestId}
						sourceHistory={snapshot?.sourceHistory ?? []}
						deploymentHistory={snapshot?.deploymentHistory ?? []}
						busy={host.busy}
						canDecide={snapshot?.capabilities.canDecideReview === true}
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
						{sections}
						{envoys}
						{tools}
						{client}
						system={client.system}
						{files}
						selected={view.selected}
						environment={vault.entries}
						environmentError={vault.error}
						onopenSource={openSource}
					/>
				{:else}
					<SourceEditor
						path={editor.path}
						value={editor.value}
						fileCount={files.length}
						{readOnly}
						onValueChange={updateEditor}
					/>
				{/if}
			</Bound>
		{/if}
	</Inline>
</Cover>

<Sheet.Root bind:open={navigatorSheetOpen}>
	{#if navigatorSheetOpen}
		<Sheet.Content flush>
			<Sheet.Header class="shrink-0 border-b border-border px-4 py-3 pr-12">
				<Sheet.Title>Workspace navigator</Sheet.Title>
				<Sheet.Description>
					{isWorkbench ? 'Workspace sections and source files.' : 'Reviews for this workspace.'}
				</Sheet.Description>
			</Sheet.Header>
			<Stack gap="none" grow class="min-h-0 bg-card">
				{@render navigator()}
			</Stack>
		</Sheet.Content>
	{/if}
</Sheet.Root>
