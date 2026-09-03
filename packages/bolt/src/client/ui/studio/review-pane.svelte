<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { CodeEditor } from '@norbital-ai/ui/code-editor';
	import { Cluster, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import BundleLogs from './bundle-logs.svelte';
	import ManifestPane from './manifest-pane.svelte';
	import type { AuthoringLiveState } from '#lib/client/ui/studio/authoring-live.js';
	import {
		boundTriple,
		canWorkOnMergeRequest,
		CHANGES_DIFF_BASELINE_KEY,
		editorLanguage,
		isChangesView,
		LIFECYCLE_RAIL,
		lifecycleRailCurrent,
		lifecycleRailMessageKey,
		lifecycleRailReached,
		mergeRequestEvidence,
		reviewFreshness,
		reviewFreshnessMessageKey,
		reviewOwnerMessageKey,
		reviewRelativeTime,
		schemaPlanSentence,
		type ChangesView,
		type EnvironmentVariable,
		type ManifestDestination,
		type ManifestSection,
		type MergeRequest,
		type WorkspaceManifest
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		releaseRequests = [],
		selectedRequestId,
		currentReleaseId,
		busy = false,
		canDecide = false,
		comments = [],
		failure,
		tracking,
		changesView = 'manifest',
		manifest,
		loading = false,
		sections = [],
		envoys = [],
		selectedManifest = 'collections',
		environment = [],
		environmentError,
		liveLogs = [],
		onview,
		onpreview,
		onapprove,
		onrequestchanges,
		onreject,
		oncomment,
		onworkon,
		onready,
		onopenSource,
		onopenDestination,
		canOpenDestination,
		onretry
	}: {
		releaseRequests?: ReadonlyArray<MergeRequest>;
		selectedRequestId?: string | undefined;
		currentReleaseId?: string | undefined;
		busy?: boolean;
		canDecide?: boolean;
		comments?: ReadonlyArray<{
			readonly requestId: string;
			readonly by: string;
			readonly body: string;
			readonly at: string;
		}>;
		failure?: string | undefined;
		tracking?: 'live' | string | undefined;
		changesView?: ChangesView;
		manifest?: WorkspaceManifest | undefined;
		loading?: boolean;
		sections?: ReadonlyArray<ManifestSection>;
		envoys?: WorkspaceManifest['envoys'];
		selectedManifest?: string;
		environment?: ReadonlyArray<EnvironmentVariable>;
		environmentError?: string | undefined;
		liveLogs?: AuthoringLiveState['logs'];
		onview?: ((next: ChangesView) => void) | undefined;
		onpreview?: ((requestId: string) => void) | undefined;
		onapprove?: ((requestId: string) => void) | undefined;
		onrequestchanges?: ((requestId: string, reason: string) => void) | undefined;
		onreject?: ((requestId: string, reason: string) => void) | undefined;
		oncomment?: ((requestId: string, body: string) => void) | undefined;
		onworkon?: ((requestId: string) => void) | undefined;
		onready?: ((requestId: string) => void) | undefined;
		onopenSource?: ((path: string) => void) | undefined;
		onopenDestination?: ((destination: ManifestDestination) => void) | undefined;
		canOpenDestination?: ((destination: ManifestDestination) => boolean) | undefined;
		onretry?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const selected = $derived(
		releaseRequests.find((request) => request.id === selectedRequestId) ?? releaseRequests.at(-1)
	);
	const freshness = $derived(
		selected === undefined ? undefined : reviewFreshness(selected, currentReleaseId)
	);
	const canActOnReview = $derived(
		selected?.state === 'ready' && canDecide && freshness === 'current'
	);
	const triple = $derived(selected === undefined ? undefined : boundTriple(selected));
	const logs = $derived(mergeRequestEvidence(selected));
	const changeTabs = $derived(
		[
			{ name: 'manifest', label: t('bolt.studio.manifest'), content: '' },
			{ name: 'files', label: t('bolt.studio.changes.files'), content: '' },
			{ name: 'data', label: t('bolt.studio.changes.data'), content: '' },
			{ name: 'conversation', label: t('bolt.studio.changes.conversation'), content: '' },
			{ name: 'logs', label: t('bolt.studio.changes.logs'), content: '' }
		] satisfies TabConfig[]
	);
	let reviewReason = $state('');
	let commentBody = $state('');
	let openSql = $state<ReadonlyArray<string>>([]);
	const thread = $derived(
		selected === undefined ? [] : comments.filter((comment) => comment.requestId === selected.id)
	);
	const canComment = $derived(
		selected !== undefined && (selected.state === 'draft' || selected.state === 'ready')
	);
	const relativeTimeLabel = (iso: string): string => {
		const relative = reviewRelativeTime(iso, Date.now());
		return relative.count === undefined
			? t(relative.messageKey)
			: t(relative.messageKey, { count: relative.count });
	};
</script>

{#if selected === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-center">
		<Icon icon="lucide:git-compare" class="size-9 text-muted-foreground/30" />
		<p class="text-sm font-medium text-foreground">{t('bolt.studio.noReviews')}</p>
	</Stack>
{:else}
	<Stack gap="none" fill class="min-h-0" data-testid="studio-release-review">
		<Stack gap="sm" shrink={false} class="border-b border-border/60 px-4 py-3 sm:px-6">
			{#if failure !== undefined}
				<p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
					{failure}
				</p>
			{/if}
			<Inline align="start" gap="sm" class="flex-wrap sm:flex-nowrap">
				<Stack gap="xs" grow class="min-w-0">
					<Cluster gap="xs">
						<h2 class="text-sm font-semibold text-foreground">
							{selected.title.trim() === ''
								? t('bolt.studio.commitValue', { commit: selected.head.slice(0, 12) })
								: selected.title}
						</h2>
						<span
							class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro text-foreground"
							data-testid="studio-release-request-status"
						>
							{t(reviewFreshnessMessageKey(selected, currentReleaseId))}
						</span>
					</Cluster>
					<ol class="flex flex-wrap gap-1" data-testid="studio-lifecycle-rail">
						{#each LIFECYCLE_RAIL as stage (stage)}
							{@const current = lifecycleRailCurrent(selected.state) === stage}
							<li
								class={[
									'rounded-full px-2 py-0.5 text-micro',
									current
										? 'bg-primary/10 font-semibold text-foreground'
										: lifecycleRailReached(selected.state, stage)
											? 'text-foreground'
											: 'text-muted-foreground'
								]}
							>
								{t(lifecycleRailMessageKey(stage))}
							</li>
						{/each}
					</ol>
					{#if triple !== undefined}
						<p class="font-mono text-micro text-muted-foreground" data-testid="studio-bound-triple">
							{t('bolt.studio.boundTriple', {
								commit: triple.commit.slice(0, 12),
								bundle: triple.bundle,
								fork: triple.fork
							})}
						</p>
					{/if}
					<p class="text-micro text-muted-foreground">
						{t('bolt.studio.reviewMetadata', {
							author: selected.openedBy,
							base: selected.baseCommit.slice(0, 12),
							created: relativeTimeLabel(selected.createdAt),
							updated: relativeTimeLabel(selected.updatedAt),
							next: t(reviewOwnerMessageKey(selected, currentReleaseId))
						})}
					</p>
				</Stack>
				<Cluster gap="xs" shrink={false}>
					{#if canWorkOnMergeRequest(selected, tracking)}
						<Button
							type="button"
							size="sm"
							disabled={busy}
							data-testid="studio-work-on-this"
							onclick={() => onworkon?.(selected.id)}
						>
							{t('bolt.studio.workOnThis')}
						</Button>
					{/if}
					{#if selected.state === 'draft' && tracking === selected.id}
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onclick={() => onready?.(selected.id)}
						>
							{t('bolt.studio.markReady')}
						</Button>
					{/if}
					{#if selected.state === 'draft' || selected.state === 'ready'}
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onclick={() => onpreview?.(selected.id)}
						>
							<Icon icon="lucide:scan-eye" class="size-3.5" />
							{t('bolt.studio.openPreview')}
						</Button>
					{/if}
				</Cluster>
			</Inline>
			<Tabs
				value={changesView}
				onValueChange={(next) => {
					if (isChangesView(next)) onview?.(next);
				}}
				showContent={false}
				animate={false}
				variant="underline"
				listClass="mx-0"
				config={changeTabs}
			/>
		</Stack>

		{#if changesView === 'manifest'}
			<Stack gap="none" grow class="min-h-0">
				<p class="shrink-0 px-4 pt-3 font-mono text-micro text-muted-foreground sm:px-6">
					{t('bolt.studio.compiledArtifact', { artifactId: selected.manifest.artifactId })}
				</p>
				<ManifestPane
					{manifest}
					{loading}
					{sections}
					{envoys}
					selected={selectedManifest}
					{environment}
					{environmentError}
					{onopenSource}
					{onopenDestination}
					{canOpenDestination}
					{onretry}
				/>
			</Stack>
		{:else if changesView === 'files'}
			<Scroll name={t('bolt.studio.changes.files')} grow>
				<Stack gap="sm" class="p-4 sm:p-6">
					<p class="text-micro text-muted-foreground">{t(CHANGES_DIFF_BASELINE_KEY)}</p>
					{#if selected.changedFiles.length === 0}
						<p class="text-meta">{t('bolt.studio.noChangedFiles')}</p>
					{:else}
						{#each selected.changedFiles as file (file.path)}
							<Stack
								gap="none"
								class="max-w-full overflow-hidden rounded-md border border-border/70"
							>
								<p
									class="border-b border-border/70 bg-muted/40 px-3 py-2 font-mono text-micro text-foreground"
								>
									{file.path}
								</p>
								<Grid
									minimum="compact"
									gap="none"
									class="divide-y divide-border/60 md:grid-cols-2 md:divide-x md:divide-y-0"
								>
									<Stack gap="xs" class="min-h-0 min-w-0 p-3">
										<span class="text-micro font-medium text-foreground"
											>{t('bolt.studio.before')}</span
										>
										{#if file.before === null}
											<span class="text-micro text-muted-foreground">∅</span>
										{/if}
										<CodeEditor
											value={file.before ?? ''}
											language={editorLanguage(file.path)}
											readonly
											ariaLabel={file.path}
											minHeight="7rem"
											class="h-full max-h-80 w-full min-h-0 rounded-none border-0 shadow-none"
										/>
									</Stack>
									<Stack gap="xs" class="min-h-0 min-w-0 p-3">
										<span class="text-micro font-medium text-foreground"
											>{t('bolt.studio.after')}</span
										>
										<CodeEditor
											value={file.after}
											language={editorLanguage(file.path)}
											readonly
											ariaLabel={file.path}
											minHeight="7rem"
											class="h-full max-h-80 w-full min-h-0 rounded-none border-0 shadow-none"
										/>
									</Stack>
								</Grid>
							</Stack>
						{/each}
					{/if}
				</Stack>
			</Scroll>
		{:else if changesView === 'data'}
			<Scroll name={t('bolt.studio.changes.data')} grow>
				<Stack gap="sm" class="p-4 sm:p-6">
					<p class="break-all font-mono text-micro text-muted-foreground">
						{selected.schemaPlan.fingerprint}
					</p>
					{#if selected.schemaPlan.steps.length === 0}
						<p class="text-meta">{t('bolt.studio.noSchemaSteps')}</p>
					{:else}
						<ul class="divide-y divide-border/50 rounded-md border border-border/70">
							{#each selected.schemaPlan.steps as step (step.id)}
								<li class="px-3 py-2">
									<p class="text-xs text-foreground">{schemaPlanSentence(step.sql)}</p>
									<Button
										type="button"
										variant="ghost"
										class="h-auto px-0 py-1 text-micro"
										aria-expanded={openSql.includes(step.id)}
										onclick={() => {
											openSql = openSql.includes(step.id)
												? openSql.filter((id) => id !== step.id)
												: [...openSql, step.id];
										}}
									>
										{t('bolt.studio.rawSql')}
									</Button>
									{#if openSql.includes(step.id)}
										<CodeEditor
											value={step.sql}
											language="plaintext"
											readonly
											ariaLabel={step.sql}
											minHeight="7rem"
											class="h-full w-full min-h-0 rounded-none border-0 shadow-none"
										/>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</Stack>
			</Scroll>
		{:else if changesView === 'conversation'}
			<Scroll name={t('bolt.studio.changes.conversation')} grow>
				<Stack gap="lg" class="p-4 sm:p-6">
					{#if selected.commits.length > 0}
						<Stack gap="xs">
							<h3 class="text-xs font-semibold text-foreground">{t('bolt.studio.history')}</h3>
							<ul class="divide-y divide-border/40">
								{#each selected.commits as commit (`${commit.commit}:${commit.at}`)}
									<li class="py-2 text-micro">
										<span class="font-medium text-foreground">{commit.by}</span>
										<span class="text-muted-foreground">
											· {commit.message} · {commit.commit.slice(0, 12)}
										</span>
									</li>
								{/each}
							</ul>
						</Stack>
					{/if}
					{#if selected.decision?.reason !== null && selected.decision?.reason !== undefined}
						<p class="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
							{selected.decision.reason}
						</p>
					{/if}
					{#if canComment}
						<Stack gap="sm" class="rounded-md border border-border/70 p-3">
							<h3 class="text-xs font-semibold text-foreground">{t('bolt.studio.comment')}</h3>
							{#each thread as comment (comment.at + comment.by)}
								<Stack gap="xs">
									<p class="text-micro text-muted-foreground">
										{comment.by} · {relativeTimeLabel(comment.at)}
									</p>
									<p class="text-xs text-foreground">{comment.body}</p>
								</Stack>
							{/each}
							<Textarea
								bind:value={commentBody}
								rows={3}
								placeholder={t('bolt.studio.commentPlaceholder')}
								aria-label={t('bolt.studio.commentAria')}
							/>
							<Button
								type="button"
								size="sm"
								disabled={busy || commentBody.trim() === ''}
								onclick={() => {
									if (selected === undefined) return;
									oncomment?.(selected.id, commentBody.trim());
									commentBody = '';
								}}
							>
								{t('bolt.studio.commentSend')}
							</Button>
						</Stack>
					{/if}
					{#if canActOnReview}
						<Stack gap="sm" class="rounded-md border border-border/70 p-3">
							<h3 class="text-xs font-semibold text-foreground">{t('bolt.studio.decision')}</h3>
							<Textarea
								bind:value={reviewReason}
								rows={3}
								placeholder={t('bolt.studio.reviewReason')}
								aria-label={t('bolt.studio.reviewReasonAria')}
							/>
							<Cluster gap="xs">
								<Button
									type="button"
									size="sm"
									disabled={busy}
									onclick={() => onapprove?.(selected.id)}
								>
									{t('bolt.studio.approveRelease')}
								</Button>
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled={busy || reviewReason.trim() === ''}
									onclick={() => onrequestchanges?.(selected.id, reviewReason.trim())}
								>
									{t('bolt.studio.requestChanges')}
								</Button>
							</Cluster>
							<Button
								type="button"
								size="sm"
								variant="ghost"
								class="w-fit px-0 text-destructive hover:text-destructive"
								disabled={busy || reviewReason.trim() === ''}
								onclick={() => onreject?.(selected.id, reviewReason.trim())}
							>
								{t('bolt.studio.closeReview')}
							</Button>
						</Stack>
					{:else if (selected.state === 'draft' || selected.state === 'ready') && freshness === 'live_advanced'}
						<p class="text-xs text-amber-700 dark:text-amber-300">
							{t('bolt.studio.rebaseRequired')}
						</p>
					{:else if selected.state === 'ready'}
						<p class="text-xs text-muted-foreground">{t('bolt.studio.waitingReviewer')}</p>
					{:else if selected.decision?.kind === 'changes_requested' || selected.decision?.kind === 'rejected'}
						<p class="text-xs text-muted-foreground">
							{t('bolt.studio.updateAfterReview')}
						</p>
					{/if}
				</Stack>
			</Scroll>
		{:else}
			<Scroll name={t('bolt.studio.changes.logs')} grow class="p-4 sm:p-6">
				<BundleLogs build={logs.build} deploy={logs.deploy} {liveLogs} />
			</Scroll>
		{/if}
	</Stack>
{/if}
