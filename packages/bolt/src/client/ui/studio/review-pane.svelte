<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { Cluster, Grid, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import type {
		ReleaseRequest,
		SourceCommit,
		StudioReviewTab
	} from '#lib/client/ui/studio/studio-state.js';

	/** The exact Preview diff, its schema plan, and durable release history. */
	let {
		tab = 'requests',
		releaseRequests = [],
		selectedRequestId,
		sourceHistory = [],
		deploymentHistory = [],
		busy = false,
		canDecide = false,
		onpreview,
		onapprove,
		onrequestchanges,
		onreject
	}: {
		tab?: StudioReviewTab;
		releaseRequests?: ReadonlyArray<ReleaseRequest>;
		selectedRequestId?: string | undefined;
		sourceHistory?: ReadonlyArray<SourceCommit>;
		deploymentHistory?: ReadonlyArray<string>;
		busy?: boolean;
		canDecide?: boolean;
		onpreview?: ((requestId: string) => void) | undefined;
		onapprove?: ((requestId: string) => void) | undefined;
		onrequestchanges?: ((requestId: string, reason: string) => void) | undefined;
		onreject?: ((requestId: string, reason: string) => void) | undefined;
	} = $props();

	const selected = $derived(
		releaseRequests.find((request) => request.id === selectedRequestId) ?? releaseRequests.at(-1)
	);
	let reviewReason = $state('');
	const statusLabel = (status: ReleaseRequest['status']): string => status.replaceAll('_', ' ');

	const plan = $derived(selected?.schemaPlan);
</script>

{#snippet empty(icon: string, heading: string, body: string)}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-center">
		<Icon {icon} class="size-10 text-muted-foreground/30" />
		<p class="text-sm font-medium text-foreground">{heading}</p>
		<p class="max-w-sm text-xs leading-relaxed text-muted-foreground">{body}</p>
	</Stack>
{/snippet}

{#if tab === 'requests'}
	{#if selected === undefined}
		{@render empty(
			'lucide:git-compare',
			'No Review selected',
			'Preview your workbench, then request review.'
		)}
	{:else}
		<Scroll name="Release review" grow>
			<Stack gap="lg" class="p-4 sm:p-6" data-testid="studio-release-review">
				<Stack gap="xs">
					<Cluster gap="sm" align="center">
						<h3 class="text-sm font-medium text-foreground">
							Commit {selected.commit.slice(0, 12)}
						</h3>
						<span
							class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro text-muted-foreground"
							data-testid="studio-release-request-status"
						>
							{statusLabel(selected.status)}
						</span>
					</Cluster>
					<p class="text-micro text-muted-foreground">
						Based on Live commit {selected.baseCommit.slice(0, 12)}.
					</p>
					<Cluster gap="xs">
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onclick={() => onpreview?.(selected.id)}
						>
							<Icon icon="lucide:scan-eye" class="size-3.5" />
							Open Preview
						</Button>
					</Cluster>
				</Stack>

				<Stack gap="sm">
					<h4 class="text-xs font-semibold text-foreground">
						{selected.changedFiles.length} changed file{selected.changedFiles.length === 1
							? ''
							: 's'}
					</h4>
					{#if selected.changedFiles.length === 0}
						<p class="text-xs text-muted-foreground">No text files changed.</p>
					{:else}
						{#each selected.changedFiles as file (file.path)}
							<Stack gap="none" class="overflow-hidden rounded-md border border-border/70">
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
									<Stack gap="xs" class="min-w-0 p-3">
										<span class="text-micro font-medium text-rose-500">Before</span>
										<pre
											class="whitespace-pre-wrap font-mono text-micro text-foreground">{file.before ??
												'∅'}</pre>
									</Stack>
									<Stack gap="xs" class="min-w-0 p-3">
										<span class="text-micro font-medium text-emerald-500">After</span>
										<pre
											class="whitespace-pre-wrap font-mono text-micro text-foreground">{file.after}</pre>
									</Stack>
								</Grid>
							</Stack>
						{/each}
					{/if}
				</Stack>

				{#if selected.reason !== null}
					<p
						class="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
					>
						{selected.reason}
					</p>
				{/if}

				{#if selected.status === 'open' && canDecide}
					<Stack gap="sm" class="rounded-md border border-border/70 p-3">
						<h4 class="text-xs font-semibold text-foreground">Decision</h4>
						<Textarea
							bind:value={reviewReason}
							rows={3}
							placeholder="Add a reason to request changes or close the review"
							aria-label="Release review reason"
						/>
						<Cluster gap="xs">
							<Button
								type="button"
								size="sm"
								disabled={busy}
								onclick={() => onapprove?.(selected.id)}
							>
								Approve and release
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy || reviewReason.trim() === ''}
								onclick={() => onrequestchanges?.(selected.id, reviewReason.trim())}
							>
								Request changes
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
							Close review
						</Button>
					</Stack>
				{:else if selected.status === 'open'}
					<p class="text-xs text-muted-foreground" role="status">Waiting for an administrator.</p>
				{:else if selected.status === 'approving'}
					<p class="text-xs text-amber-500" role="status">
						Release is applying the exact reviewed Preview. Repeating approval resumes it.
					</p>
				{/if}
			</Stack>
		</Scroll>
	{/if}
{:else if tab === 'history'}
	<Scroll name="Release history" grow>
		<Stack gap="lg" class="p-4 sm:p-6" data-testid="studio-release-history">
			<Stack gap="sm">
				<h3 class="text-sm font-medium text-foreground">Workbench commits</h3>
				{#if sourceHistory.length === 0}
					<p class="text-xs text-muted-foreground">No workbench commits yet.</p>
				{:else}
					<ol class="divide-y divide-border/60 rounded-md border border-border/70">
						{#each [...sourceHistory].reverse() as entry (entry.commit)}
							<li class="px-3 py-2">
								<p class="text-xs font-medium text-foreground">
									Commit {entry.commit.slice(0, 12)}
								</p>
								<p class="font-mono text-micro text-muted-foreground">
									{entry.changes.map((change) => change.path).join(', ') || 'No text changes'}
								</p>
							</li>
						{/each}
					</ol>
				{/if}
			</Stack>
			<Stack gap="sm">
				<h3 class="text-sm font-medium text-foreground">Deployment history</h3>
				{#if deploymentHistory.length === 0}
					<p class="text-xs text-muted-foreground">No release is routed.</p>
				{:else}
					<ol class="divide-y divide-border/60 rounded-md border border-border/70">
						{#each [...deploymentHistory].reverse() as releaseId, index (releaseId)}
							<li class="px-3 py-2 font-mono text-micro text-foreground">
								{releaseId}{index === 0 ? ' · current' : ''}
							</li>
						{/each}
					</ol>
				{/if}
			</Stack>
		</Stack>
	</Scroll>
{:else}
	<Stack gap="md" class="p-4 sm:p-6">
		<Stack as="section" gap="sm" data-testid="review-schema-plan">
			<Stack gap="xs">
				<h3 class="text-sm font-medium text-foreground">Schema</h3>
				<p class="max-w-2xl text-xs leading-relaxed text-muted-foreground">
					The exact ordered DDL for this Preview. Release verifies it before routing Live.
				</p>
			</Stack>
			{#if plan === undefined}
				<p class="text-meta">Select a release request to inspect its compiled schema plan.</p>
			{:else}
				<p class="font-mono text-micro break-all text-foreground">{plan.fingerprint}</p>
				<p class="text-meta">
					{plan.steps.length} step{plan.steps.length === 1 ? '' : 's'} in the plan
				</p>
			{/if}
		</Stack>
		{#if plan !== undefined && plan.steps.length > 0}
			<Scroll name="Schema plan" class="max-h-96 rounded-md border border-border/70">
				<ul class="divide-y divide-border/50">
					{#each plan.steps as step (step.id)}
						<li class="px-3 py-2">
							<!-- repository-health:allow UI17 -- a schema-plan step id IS its operator-facing label; it encodes apply order and a step has no other name -->
							<p class="text-micro text-muted-foreground">{step.id}</p>
							<pre class="whitespace-pre-wrap font-mono text-micro text-foreground">{step.sql}</pre>
						</li>
					{/each}
				</ul>
			</Scroll>
		{/if}
	</Stack>
{/if}
