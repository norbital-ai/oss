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
	import { Spinner } from '@norbital-ai/ui/spinner';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import {
		studioMetrics,
		type FacilityState,
		type MatrixEntry,
		type ReleaseControls,
		type SourceSnapshot,
		type UsageObservation
	} from './studio-state.js';

	/**
	 * Command panel: what this tenant's runtime is, what it is holding, and what may still be done to it.
	 *
	 * Every control here maps to an operation that exists. `build` compiles the committed source
	 * into an artifact and routes it; `rollback` steps the environment's deployment history back one
	 * release. Nothing on this page describes work the platform cannot carry out, and where the host
	 * reports no measurement the tile says so instead of showing a zero.
	 */
	let {
		snapshot,
		busy = false,
		controls,
		onrefresh,
		onbuild,
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
		busy?: boolean;
		controls?: ReleaseControls | undefined;
		onrefresh?: () => void;
		onbuild?: () => void;
		onrollback?: () => void;
	} = $props();

	/** Which of the panel's two nested views is open; the panel owns it, nothing above needs it. */
	let activeView = $state('tenant-matrix');

	const live = $derived(snapshot?.entries.find((entry) => entry.environmentId === 'live'));
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
		<Grid minimum="compact" gap="sm" data-testid="command-metrics">
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

		<TenantMatrix entries={snapshot?.entries ?? []} revision={snapshot?.source.revision ?? 0} />

		<Stack
			as="section"
			gap="sm"
			class="rounded-lg border border-border/70 bg-card/20 p-4"
			data-testid="command-workbenches"
		>
			<Stack gap="xs">
				<h3 class="text-xs font-semibold text-foreground">Workbenches</h3>
				<p class="max-w-2xl text-xs leading-relaxed text-muted-foreground">
					A workbench is a sandbox tree this tenant's agent work runs in. A session opens it, and
					its tree stays on disk after the session closes — a restart keeps the trees and loses the
					sessions, so both halves are listed. This host binds workbenches to the workspace, not to
					a user.
				</p>
			</Stack>
			{#if (snapshot?.workbenches ?? []).length === 0}
				<p class="text-meta">
					No workbenches for this tenant yet. One opens when a workbench command runs.
				</p>
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
								{workbench.open ? 'open' : 'materialized'}
							</span>
						</Inline>
					{/each}
				</ul>
			{/if}
		</Stack>
	</Stack>
{/snippet}

{#snippet templateView()}
	<Stack
		gap="sm"
		class="rounded-lg border border-border/70 bg-card/20 p-4"
		data-testid="command-template-updates"
	>
		<h3 class="text-xs font-semibold text-foreground">Template updates</h3>
		<p class="max-w-2xl text-meta">
			This host has no template update channel. It reports the release and artifact a route resolves
			to, and nothing about the runtime version an artifact was built against or a newer one being
			published — so there is no update to offer, and no auto-update to switch on.
		</p>
		<p class="max-w-2xl text-meta">
			Rebuilding is the whole of the mechanism that exists: <strong>Build</strong> compiles the committed
			source against the runtime this host is running and routes the result.
		</p>
	</Stack>
{/snippet}

<!--
	The whole panel is monospace at `text-xs`. It reads identifiers — release ids, artifact ids,
	fingerprints, DDL — and a proportional face makes two hashes that differ in one character look
	the same length.
-->
<Bound size="full" clip class="bg-background font-mono text-xs" data-testid="command-pane">
	<Scroll name="Workspace operations" grow>
		<Center measure="wide" layout="stack" gap="md" class="min-h-full py-4 sm:py-6">
			<Cluster as="header" align="start" justify="between" gap="sm">
				<Stack gap="xs" grow class="min-w-0">
					<h1 class="text-sm font-semibold text-foreground">Command panel</h1>
					<p class="max-w-2xl text-meta">
						Routing, facilities, schema and metered usage for this tenant.
					</p>
				</Stack>
				<Button type="button" size="sm" class="gap-2" disabled={busy} onclick={() => onrefresh?.()}>
					{#if busy}
						<Spinner class="size-3.5" />
					{:else}
						<Icon icon="lucide:refresh-cw" class="size-3.5" />
					{/if}
					Refresh runtime state
				</Button>
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
									{#if live}<Badge variant="success">live</Badge>{/if}
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
								{:else if live === undefined}
									<p class="text-meta">
										No live release. Commit the workspace source, then build it.
									</p>
								{:else}
									<Cluster gap="md" class="text-xs">
										<span class="font-mono">{live.releaseId}</span>
										<span class="font-mono text-muted-foreground">deploy {live.artifactId}</span>
										<span class="text-muted-foreground">revision {snapshot.source.revision}</span>
										<span class="text-muted-foreground">{live.health}</span>
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
									Build compiles and routes the committed source; Rollback steps back one release.
								</p>
								<Cluster gap="xs">
									<Button
										type="button"
										size="sm"
										disabled={controls?.canBuild !== true}
										disabledMessage={controls?.reason ?? 'Reading host state.'}
										onclick={() => onbuild?.()}
									>
										<Icon icon="lucide:rocket" class="size-3.5" />
										Build
									</Button>
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

					<!-- The panel is one scrolling page, so the tab body flows into that scroll rather than
					     bounding itself; a self-bounded panel inside a scrollport is a second scrollport,
					     and the wheel then belongs to whichever one the pointer happens to be over. -->
					<Stack gap="none" class="min-h-0">
						<Tabs
							bind:value={activeView}
							variant="underline"
							animate={false}
							contentPadding={false}
							listClass="mx-0 w-fit max-w-full"
							config={[
								{
									name: 'tenant-matrix',
									label: 'Tenant matrix',
									icon: 'lucide:network',
									content: matrixView
								},
								{
									name: 'template',
									label: 'Template updates',
									icon: 'lucide:git-fork',
									content: templateView
								}
							] satisfies TabConfig[]}
						/>
					</Stack>
				</Stack>
			</div>
		</Center>
	</Scroll>
</Bound>
