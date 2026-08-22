<script lang="ts">
	import { onMount } from 'svelte';
	import { Effect, Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import CommandPane from './command-pane.svelte';
	import ManifestPane from './manifest-pane.svelte';
	import ManifestTree from './manifest-tree.svelte';
	import SourceEditor from './source-editor.svelte';
	import ReviewPane from './review-pane.svelte';
	import ReviewSidebar from './review-sidebar.svelte';
	import AuthoringToolbar from './authoring-toolbar.svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Bound, Cluster, Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { workspaceSession } from '#lib/client/session.js';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
	import {
		LIVE_READ_ONLY_NOTICE,
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
	 * Workspace Studio: Authoring, Review and the Command panel over one tenant.
	 *
	 * Authoring is the workspace as it declares itself — the manifest tree and its panels — and the
	 * source that declares it, edited into a revision the host holds. Review is where a proposed
	 * release would be read. The Command panel is the tenant's own runtime: what is routed, what it
	 * is holding, and the release operations that may still be applied to it.
	 *
	 * The page owns one gutter and one chrome rhythm: heading, root rail, then a nested rail that
	 * belongs to whichever root tab is open. Authoring and Review both hang their navigator in the
	 * same fixed-width slot, so switching between them never moves the viewport.
	 *
	 * Every control is driven by a command that exists. Where the host has no capability the Studio
	 * says so in the surface that would have used it, rather than offering a control that quietly
	 * does nothing or an empty list that reads as "none".
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
			revision: Schema.Natural,
			files: Schema.Record(Schema.String, Schema.String)
		}),
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
		authoring: AuthoringView;
		review: StudioReviewTab;
		selected: string;
		expanded: ReadonlyArray<string>;
		environmentId: string | undefined;
	}>({
		rootTab: 'authoring',
		authoring: 'manifest',
		review: 'requests',
		selected: 'collections',
		expanded: ['collections'],
		environmentId: undefined
	});
	/** The file open in the Editor and its working copy; a commit writes exactly this pair. */
	let editor = $state({ path: '', value: '' });
	let mounted = $state(false);
	const manifestQuery = $derived(mounted ? client.system.workspace.manifest({}) : undefined);
	const workspace = $derived({
		manifest: manifestQuery?.current,
		error:
			manifestQuery?.error === undefined
				? undefined
				: manifestQuery.error instanceof Error
					? manifestQuery.error.message
					: String(manifestQuery.error)
	});
	const environmentQuery = $derived(mounted ? client.system.secrets.status({}) : undefined);
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
			environment: activeEnvironment,
			busy: host.busy,
			accepting: snapshot?.readiness.accepting ?? false,
			hasRelease: (activeEnvironment?.releaseId ?? '') !== ''
		})
	);
	const readOnly = $derived(activeEnvironment?.readOnly === true);
	const isAuthoring = $derived(view.rootTab === 'authoring');
	const isReview = $derived(view.rootTab === 'review');
	const isCommand = $derived(view.rootTab === 'command');

	/** Opens an authored file in the Editor; "View model" and "View source" both land here. */
	const openSource = (path: string): void => {
		if (path === '') return;
		view.authoring = 'editor';
		view.selected = `source:${path}`;
		editor = { path, value: snapshot?.source.files[path] ?? '' };
	};

	const actions = {
		/**
		 * Reads host state. It deliberately does not claim `busy`.
		 *
		 * This runs on a timer, and `busy` is what disables the release controls: claiming it here
		 * greyed out Commit and Build every five seconds and flashed "a command is already running"
		 * under them, for a poll nobody asked for.
		 */
		reload: (): Effect.Effect<void> =>
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
		operation: (body: Schema.Json, describe: () => string): Effect.Effect<void> =>
			Effect.gen(function* () {
				host.busy = true;
				yield* Effect.tryPromise(() => session.operations.run(body));
				host.status = describe();
				yield* actions.reload();
			}).pipe(
				Effect.catch((cause) => {
					host.status = `Failed: ${cause instanceof Error ? cause.message : String(cause)}`;
					return Effect.void;
				}),
				Effect.ensuring(Effect.sync(() => (host.busy = false)))
			),
		build: () =>
			actions.operation({ action: 'build' }, () => 'Compiled the source and routed the release'),
		rollback: () =>
			actions.operation({ action: 'rollback' }, () => 'Rolled back to the previous release'),
		commit: () =>
			actions.operation(
				{
					action: 'source',
					expectedRevision: snapshot?.source.revision ?? 0,
					files: { [editor.path]: editor.value }
				},
				() => `Committed ${editor.path}`
			)
	};

	onMount(() => {
		mounted = true;
		void Effect.runPromise(actions.reload());
		const interval = setInterval(() => {
			void Effect.runPromise(actions.reload());
		}, 5_000);
		return () => clearInterval(interval);
	});
</script>

<!--
	One navigator, rendered into the fixed sidebar slot on md and up and into a sheet below it. Both
	mounts read the same `view` cell, so opening a branch from the sheet leaves the reader exactly
	where the sidebar would have.
-->
{#snippet navigator()}
	{#if isAuthoring}
		<ManifestTree
			{sections}
			{files}
			{fileSizes}
			selected={view.selected}
			expanded={view.expanded}
			view={view.authoring}
			{readOnly}
			onselect={(key) => {
				view.selected = key;
				if (key.startsWith('source:')) {
					const path = key.slice('source:'.length);
					editor = { path, value: snapshot?.source.files[path] ?? '' };
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
		<ReviewSidebar source={snapshot?.source} />
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
					Author, review, and operate the source and releases behind this workspace.
				</p>
			</Stack>
			<Cluster gap="sm" align="center" shrink={false}>
				<Tabs
					value={view.rootTab}
					onValueChange={(next) => {
						if (next === 'authoring' || next === 'review' || next === 'command') {
							view.rootTab = next;
						}
					}}
					showContent={false}
					animate={false}
					variant="default"
					layout="responsive"
					class="min-w-0 flex-1 !shrink"
					listClass="mx-0 w-full"
					config={[
						{ name: 'authoring', label: 'Authoring', content: '' },
						{ name: 'review', label: 'Review', content: '' },
						{ name: 'command', label: 'Command panel', content: '' }
					] satisfies TabConfig[]}
				/>
				{#if !isCommand}
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

		{#if !isCommand}
			<!-- The root rail and every nested tab surface share one page gutter. Keeping the gutter on
			     this parent prevents Authoring and Review from drifting independently. -->
			<Stack gap="none" shrink={false} class="px-4 sm:px-6">
				{#if isAuthoring}
					<AuthoringToolbar
						{environments}
						{activeEnvironment}
						hostStatus={host.status}
						view={view.authoring}
						commitDisabled={!controls.canCommit || editor.path === ''}
						commitReason={controls.reason ?? 'Open a file in the Editor to commit it.'}
						onenvironment={(id) => (view.environmentId = id)}
						onview={(next) => (view.authoring = next)}
						oncommit={() => void Effect.runPromise(actions.commit())}
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
								{ name: 'requests', label: 'Release requests', content: '' },
								{ name: 'history', label: 'History', content: '' },
								{ name: 'schema', label: 'Schema', content: '' }
							] satisfies TabConfig[]}
						/>
					</Cluster>
				{/if}

				{#if isAuthoring && readOnly}
					<Inline
						gap="xs"
						shrink={false}
						class="h-6 border-b border-amber-500/30 bg-amber-500/10 px-2 text-amber-900 dark:text-amber-100"
						role="status"
						data-testid="studio-readonly-notice"
					>
						<Icon icon="lucide:info" class="size-3 shrink-0" />
						<span class="truncate text-xs leading-none">{LIVE_READ_ONLY_NOTICE}</span>
					</Inline>
				{/if}
				{#if isAuthoring && missingFacilities.length > 0}
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
				{#if isAuthoring && workspace.error !== undefined}
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

	<!-- One page gutter for every root tab. Letting the Command panel drop it is what made its
	     heading sit a step further left than Authoring's. -->
	<Inline align="stretch" gap="none" fill class="px-4 sm:px-6">
		{#if isCommand}
			<Bound size="full" grow clip class="bg-background font-sans">
				<CommandPane
					{snapshot}
					{controls}
					busy={host.busy}
					onrefresh={() => void Effect.runPromise(actions.reload())}
					onbuild={() => void Effect.runPromise(actions.build())}
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
					<ReviewPane tab={view.review} source={snapshot?.source} system={client.system} />
				{:else if view.authoring === 'manifest'}
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
						onValueChange={(value) => (editor = { ...editor, value })}
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
					The branches of this workspace's manifest, and the source files behind them.
				</Sheet.Description>
			</Sheet.Header>
			<Stack gap="none" grow class="min-h-0 bg-card">
				{@render navigator()}
			</Stack>
		</Sheet.Content>
	{/if}
</Sheet.Root>
