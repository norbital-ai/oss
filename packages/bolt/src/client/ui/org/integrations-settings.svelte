<script lang="ts">
	import { Effect } from 'effect';
	import type { IntegrationSyncStatus } from '@norbital-ai/bolt-protocol';
	import { Button } from '@norbital-ai/ui/button';
	import { Bound, Cover, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';

	/**
	 * Settings → Integrations (integrations.md §9.7): one row per integration, one sub-row per sync —
	 * its state and consistency bound, the last report with samples, and the operator's actions.
	 */
	let { client }: { client: WorkspaceClient } = $props();

	let generation = $state(0);
	const statusQuery = $derived.by(() => {
		void generation;
		return client.system.integrations.status({});
	});
	const syncs = $derived<ReadonlyArray<IntegrationSyncStatus>>(statusQuery.current ?? []);
	const integrations = $derived([...new Set(syncs.map(({ integration }) => integration))]);
	let acting = $state<string | null>(null);
	let actionError = $state<string | null>(null);

	type Action = 'start' | 'reconcile' | 'pause' | 'resume' | 'retry';
	const act = (sync: IntegrationSyncStatus, action: Action): void => {
		acting = `${sync.integration}.${sync.sync}:${action}`;
		actionError = null;
		Effect.runFork(
			client.system.integrations
				.control({ integration: sync.integration, sync: sync.sync, action })
				.pipe(
					Effect.map(() => {
						generation += 1;
					}),
					Effect.catch((cause) => {
						actionError = cause instanceof Error ? cause.message : 'The runtime refused this action.';
						return Effect.void;
					}),
					Effect.ensuring(Effect.sync(() => (acting = null)))
				)
		);
	};

	const stateLabel = (sync: IntegrationSyncStatus): string =>
		sync.state === 'backfilling'
			? `backfilling${sync.page === null ? '' : ` · page ${sync.page}`}`
			: sync.state === 'failed'
				? `failed: ${sync.detail ?? 'see the report'}`
				: sync.state;
	const boundLabel = (sync: IntegrationSyncStatus): string =>
		[
			sync.bound.subscribe ? 'pushed within seconds' : undefined,
			sync.bound.changes === null ? undefined : `changes on ${sync.bound.changes}`,
			`full check on ${sync.bound.reconcile}`
		]
			.filter((part) => part !== undefined)
			.join(' · ');
</script>

<Bound size="full" clip class="bg-background">
	<Cover gap="lg" class="px-4 pt-4 sm:px-6 sm:pt-6">
		{#snippet top()}
			<Stack as="header" gap="xs" shrink={false}>
				<h1 class="text-heading">Integrations</h1>
				<p class="max-w-2xl text-meta">
					Records this workspace keeps consistent with other systems, declared in
					<code>src/integrations/</code>. Each sync converges within its bound; a conflict is settled by
					its declared rule and recorded.
				</p>
			</Stack>
		{/snippet}
		<Scroll name="Integrations" layout="stack" gap="lg" class="max-w-4xl pb-4 sm:pb-6">
			{#if statusQuery.loading && statusQuery.current === undefined}
				<p class="text-sm text-muted-foreground">Reading the integrations…</p>
			{:else if statusQuery.error !== undefined}
				<p class="text-sm text-destructive" role="alert">
					{statusQuery.error instanceof Error ? statusQuery.error.message : 'Unable to read the integrations.'}
				</p>
			{:else if syncs.length === 0}
				<section class="rounded-lg border border-dashed border-border/70 bg-card/20 p-8 text-center">
					<p class="text-sm text-muted-foreground">
						No integrations declared. Author one in <code>src/integrations/</code> to keep a collection in
						step with another system.
					</p>
				</section>
			{:else}
				{#if actionError !== null}
					<p class="text-sm text-destructive" role="alert">{actionError}</p>
				{/if}
				{#each integrations as integration (integration)}
					<Stack as="section" gap="sm" class="rounded-lg border border-border bg-card p-4 shadow-card">
						<p class="font-mono text-sm font-semibold text-foreground">{integration}</p>
						{#each syncs.filter((sync) => sync.integration === integration) as sync (sync.sync)}
							<Stack gap="sm" class="border-t pt-3">
								<Inline gap="sm" align="center" justify="between" class="flex-wrap">
									<p class="text-sm">
										<span class="font-mono">{sync.collection}</span>
										<span class="text-meta">· {sync.direction.replace('_', '-')} · {stateLabel(sync)}</span>
									</p>
									<Inline gap="xs" class="flex-wrap">
										{#if sync.state === 'unlinked'}
											<Button size="sm" disabled={acting !== null} onclick={() => act(sync, 'start')}>Start first sync</Button>
										{:else}
											<Button size="sm" variant="outline" disabled={acting !== null} onclick={() => act(sync, 'reconcile')}>Reconcile now</Button>
										{/if}
										{#if sync.state === 'paused'}
											<Button size="sm" variant="outline" disabled={acting !== null} onclick={() => act(sync, 'resume')}>Resume</Button>
										{:else}
											<Button size="sm" variant="outline" disabled={acting !== null} onclick={() => act(sync, 'pause')}>Pause</Button>
										{/if}
										{#if sync.deadLetters > 0}
											<Button size="sm" variant="outline" disabled={acting !== null} onclick={() => act(sync, 'retry')}>Retry dead letters</Button>
										{/if}
									</Inline>
								</Inline>
								<p class="text-meta">{boundLabel(sync)}</p>
								<Grid as="dl" gap="sm" minimum="compact" class="text-xs">
									<Stack gap="xs">
										<dt class="font-medium text-foreground">Pending pushes</dt>
										<dd class="text-muted-foreground">{sync.pending}</dd>
									</Stack>
									<Stack gap="xs">
										<dt class="font-medium text-foreground">Dead letters</dt>
										<dd class={sync.deadLetters > 0 ? 'text-destructive' : 'text-muted-foreground'}>{sync.deadLetters}</dd>
									</Stack>
									<Stack gap="xs">
										<dt class="font-medium text-foreground">Conflicts logged</dt>
										<dd class="text-muted-foreground">{sync.conflicts}</dd>
									</Stack>
								</Grid>
								{#if sync.report !== null}
									{@const report = sync.report}
									<Stack gap="xs" class="text-xs">
										<p class="font-medium text-foreground">
											Last {report.mode} · {report.finishedAt}
										</p>
										<p class="text-muted-foreground">
											matched {report.matched} · created {report.created} · updated {report.updated} · deleted
											{report.deleted} · pushed {report.pushed} · unmatched {report.unmatched} · rejected
											{report.rejected} · conflicts {report.conflicts}
										</p>
										{#each Object.entries(report.samples) as [kind, samples] (kind)}
											{#if samples.length > 0}
												<p class="text-meta"><span class="font-medium">{kind}:</span> {samples.join(', ')}</p>
											{/if}
										{/each}
									</Stack>
								{/if}
							</Stack>
						{/each}
					</Stack>
				{/each}
			{/if}
		</Scroll>
	</Cover>
</Bound>
