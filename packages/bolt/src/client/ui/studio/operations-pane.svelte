<script lang="ts">
	import Icon from '@iconify/svelte';
	import TenantMatrix from './tenant-matrix.svelte';
	import { Badge } from '@norbital-ai/ui/badge';
	import { Button } from '@norbital-ai/ui/button';
	import {
		Bound,
		Center,
		Cluster,
		Grid,
		Inline,
		Scroll,
		Split,
		Stack
	} from '@norbital-ai/ui/layout';
	import {
		currentRoutedRelease,
		studioMetrics,
		type FacilityState,
		type MatrixEntry,
		type ReleaseControls,
		type SourceSnapshot,
		type UsageObservation
	} from '#lib/client/ui/studio/studio-state.js';

	/**
	 * Operations: what this tenant's runtime is, what it is holding, and what may still be done to it.
	 *
	 * Every control here maps to an operation that exists. Preview and Review live
	 * in Workbench and Review; this panel can step the environment's deployment history back one
	 * release. Where the host reports no measurement the tile says so instead of showing a zero.
	 */
	let {
		snapshot,
		controls,
		onrollback
	}: {
		// `exactOptionalPropertyTypes`: the parent passes `undefined` while the load is in flight,
		// which is a different statement from omitting the prop.
		snapshot?:
			| Readonly<{
					readonly entries: ReadonlyArray<MatrixEntry>;
					readonly usage: ReadonlyArray<UsageObservation>;
					readonly readiness: { readonly accepting: boolean; readonly outstanding: number };
					readonly source: SourceSnapshot;
					readonly workbenches: ReadonlyArray<{
						readonly workspaceKey: string;
						readonly open: boolean;
					}>;
					readonly facilities: ReadonlyArray<FacilityState>;
			  }>
			| undefined;
		controls?: ReleaseControls | undefined;
		onrollback?: () => void;
	} = $props();

	const currentRelease = $derived(currentRoutedRelease(snapshot?.entries ?? []));
	const metrics = $derived(
		studioMetrics({
			usage: snapshot?.usage ?? [],
			source: snapshot?.source,
			workbenches: snapshot?.workbenches ?? []
		})
	);
</script>

{#snippet matrixView()}
	<Stack gap="lg">
		<Grid minimum="compact" gap="sm" data-testid="studio-operations-metrics">
			{#each metrics as metric (metric.id)}
				<Stack as="section" gap="xs" class="rounded-lg border border-border/70 bg-card/20 p-3">
					<Inline gap="xs" class="text-micro font-medium text-muted-foreground">
						<Icon icon={metric.icon} class="size-3.5 shrink-0" />
						<span>{metric.label}</span>
					</Inline>
					<span
						class={metric.value === undefined
							? 'text-meta'
							: 'text-sm font-semibold tabular-nums text-foreground'}
					>
						{metric.value ?? 'not measured'}
					</span>
					<span class="text-micro text-muted-foreground">{metric.detail}</span>
				</Stack>
			{/each}
		</Grid>

		<TenantMatrix entries={snapshot?.entries ?? []} commit={snapshot?.source.commit ?? ''} />

		<Stack
			as="section"
			gap="sm"
			class="border-t border-border/70 pt-4"
			data-testid="studio-operations-workbenches"
		>
			<Stack gap="xs">
				<h3 class="text-xs font-semibold text-foreground">Workbenches</h3>
				<p class="max-w-2xl text-xs leading-relaxed text-muted-foreground">
					One private workbench per principal. Its files persist outside Bolt; active sessions do
					not. Administrators cannot open another principal's workbench.
				</p>
			</Stack>
			{#if (snapshot?.workbenches ?? []).length === 0}
				<p class="text-meta">No workbenches yet.</p>
			{:else}
				<ul class="divide-y divide-border/50">
					{#each snapshot?.workbenches ?? [] as workbench (workbench.workspaceKey)}
						<Inline as="li" align="center" justify="between" gap="sm" class="py-1.5">
							<span class="font-mono text-xs text-foreground">{workbench.workspaceKey}</span>
							<span
								class={workbench.open
									? 'rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-micro text-emerald-500'
									: 'rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro text-muted-foreground'}
								role="status"
							>
								{workbench.open ? 'active' : 'stored'}
							</span>
						</Inline>
					{/each}
				</ul>
			{/if}
		</Stack>
	</Stack>
{/snippet}

<!--
	The whole panel is monospace at `text-xs`. It reads identifiers — release ids, artifact ids,
	fingerprints, DDL — and a proportional face makes two hashes that differ in one character look
	the same length.
-->
<Bound size="full" clip class="bg-background font-mono text-xs" data-testid="studio-operations">
	<Scroll name="Workspace operations" grow>
		<Center measure="wide" layout="stack" gap="md" class="min-h-full py-4 sm:py-6">
			<Cluster as="header" align="start" gap="sm">
				<Stack gap="xs" grow class="min-w-0">
					<h1 class="text-sm font-semibold text-foreground">Operations</h1>
					<p class="max-w-2xl text-meta">
						Routing, facilities, schema and metered usage for this tenant.
					</p>
				</Stack>
			</Cluster>

			<div class="min-h-0 grow rounded-lg border border-border/70 bg-card/30 p-4">
				<!-- The release summary and its nested operational views are two reading groups. Keep the
				     separation in the owning Stack so every tab gets it, not just the matrix. -->
				<Stack gap="lg" fill>
					<Split ratio="wide" collapse="stack" gap="none">
						{#snippet start()}
							<Stack
								gap="sm"
								class="min-w-0 border-b border-border/70 py-1 pb-4 md:border-r md:border-b-0 md:pr-4 md:pb-1"
							>
								<Cluster gap="sm">
									<p class="text-xs font-semibold">Current release</p>
									{#if currentRelease}
										<Badge variant="success">
											{currentRelease.environmentId === 'live' ? 'live' : 'routed'}
										</Badge>
									{/if}
									<Badge variant={snapshot?.readiness.accepting === false ? 'warning' : 'outline'}>
										{snapshot === undefined
											? 'reading'
											: snapshot.readiness.accepting
												? 'accepting work'
												: 'draining'}
									</Badge>
								</Cluster>
								{#if snapshot === undefined}
									<p class="text-meta">Reading deployment state…</p>
								{:else if currentRelease === undefined}
									<p class="text-meta">
										No release is routed for this tenant. Build Preview, request Review, then
										approve it.
									</p>
								{:else}
									<Cluster gap="md" class="text-xs">
										<span class="font-mono">{currentRelease.releaseId}</span>
										<span class="font-mono text-muted-foreground"
											>deploy {currentRelease.artifactId}</span
										>
										<span class="text-muted-foreground"
											>commit {snapshot.source.commit.slice(0, 12)}</span
										>
										<span class="text-muted-foreground">{currentRelease.health}</span>
									</Cluster>
								{/if}
								<p class="text-micro text-muted-foreground">
									{snapshot?.readiness.outstanding ?? 0} request{(snapshot?.readiness.outstanding ??
										0) === 1
										? ''
										: 's'} in flight.
								</p>
							</Stack>
						{/snippet}
						{#snippet end()}
							<!-- This is the narrow half of the split, so the controls sit under their label
							     rather than beside it; a two-column row here wrapped the sentence one word
							     wide. -->
							<Stack gap="xs" class="min-w-0 pt-4 md:pt-1 md:pl-4">
								<p class="text-xs font-semibold">Release operations</p>
								<p class="text-micro leading-relaxed text-muted-foreground">
									Approval releases an exact reviewed Preview; Rollback steps back one release.
								</p>
								<Cluster gap="xs">
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={controls?.canRollback !== true}
										disabledMessage={controls?.reason ??
											'There is no earlier release to step back to.'}
										onclick={() => onrollback?.()}
									>
										Rollback
									</Button>
								</Cluster>
							</Stack>
						{/snippet}
					</Split>

					{@render matrixView()}
				</Stack>
			</div>
		</Center>
	</Scroll>
</Bound>
