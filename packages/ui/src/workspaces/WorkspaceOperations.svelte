<!--
@component
A workspace's operations panel: bundle, telemetry, logs, users, activity and improvements views over data its owner reads
for the chosen scope. Every view stays bounded inside its viewport so tables, boards and grids scroll internally.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Snippet } from 'svelte';
	import type {
		WorkspaceOperationsData,
		WorkspaceScope,
		WorkspaceRange,
		WorkspaceView
	} from './types.js';
	type WorkspaceOperationsProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** Everything the views show, read by the owner for the current scope. */
		data: WorkspaceOperationsData;
		/** The telemetry trend window. */
		range: WorkspaceRange;
		/** The view shown. */
		view: WorkspaceView;
		/** The views to offer, in order; with one, it renders without its own tab strip. */
		views: readonly WorkspaceView[];
		/** Marks the panel busy while the owner reads. Default false. */
		busy?: boolean;
		/** The viewer changed the view, range or run filter: only the changed keys; the owner rereads `data`. */
		on_change: (next: WorkspaceScope) => void;
		/** Translates the panel's English strings (keys are the English text). Default: identity. */
		t?: (key: string) => string;
		/**
		 * The release whose logs Logs shows, by its publication instant (`at`); omitted or `null`, every release. Bind it to
		 * read the selection (the owner scopes its own log read to `release_window`).
		 */
		release?: string | null;
		/** Trailing controls on the Logs header line (an Auto-refresh toggle). */
		actions?: Snippet;
		/** Opens an improvement thread's agent conversation; without it, the board's cards do not open. */
		on_conversation?: (id: string) => void;
	};
</script>

<script lang="ts">
	import Badge, { type BadgeVariant } from '../primitives/badge/badge.svelte';
	import Button from '../primitives/button/button.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import Tabs from '../primitives/tabs/tabs.svelte';
	import LocalBoard from '../board/LocalBoard.svelte';
	import Table from '../table/Table.svelte';
	import Scroll from '../layout/scroll.svelte';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import LogView from '../logs/LogView.svelte';
	import UsageChart, { format_metric_value, type UsageChartProps } from '../chart/UsageChart.svelte';
	import { memberStatus, newestReleases, release_window } from './filters.js';

	let {
		ctx,
		data,
		range,
		view,
		views,
		busy = false,
		on_change,
		t = (key) => key,
		release = $bindable(),
		actions,
		on_conversation
	}: WorkspaceOperationsProps = $props();
	let runSearch = $state('');
	let telemetryGroup = $state<string | undefined>(undefined);
	const can_inspect = $derived(data.can_inspect);
	const studio = $derived(data.studio),
		members = $derived(data.members),
		bundles = $derived(data.bundles),
		cache = $derived(data.cache);
	const STATUS = {
		recent: 'Recently active',
		offline: 'Offline',
		unknown: 'Unknown',
		disabled: 'Disabled'
	} as const;
	// each list's rows carry the words its toolbar searches, filters and sorts on
	const memberRows = $derived(
		(members ?? []).map((member) => ({
			...member,
			email_text: member.email ?? t('Not recorded'),
			status: t(STATUS[memberStatus(member, data.as_of)]),
			last_seen_text: when(member.last_seen)
		}))
	);
	const cacheByPath = $derived(new Map((cache?.assets ?? []).map((asset) => [asset.path, asset])));
	const assetRows = $derived(
		(bundles?.assets ?? []).map((asset) => {
			const held = cacheByPath.get(asset.path);
			return {
				...asset,
				id: asset.path,
				size_text: bytes(asset.bytes),
				variants: held?.variants.map((variant) => variant.encoding).join(', ') || t('Not resident')
			};
		})
	);
	const packageRows = $derived(
		(data.health?.packages ?? []).map((pkg) => ({
			...pkg,
			id: `${pkg.source}:${pkg.name}`,
			source_text: t(pkg.source)
		}))
	);
	const runOptions = $derived.by(() => {
		const ids = new Set((data.logs ?? []).flatMap((row) => (row.run === null ? [] : [row.run])));
		if (data.filters.run) ids.add(data.filters.run);
		const asked = runSearch.trim().slice(0, 200);
		if (asked) ids.add(asked);
		return [
			{ value: '', label: t('All runs') },
			...Array.from(ids, (id) => ({ value: id, label: id, keywords: id }))
		];
	});
	// Logs reads every release unless one is chosen
	const releases = $derived(newestReleases(studio?.releases ?? []));
	const releaseAt = $derived(release ?? null);
	const releaseOptions = $derived([
		{ value: '', label: t('All releases') },
		...releases.map((r) => ({
			value: r.at,
			label: `${(r.rollback ?? r.commit).slice(0, 8)} · ${when(r.at)}${r.current ? ` · ${t('serving')}` : ''}`,
			keywords: `${r.commit} ${r.message}`
		}))
	]);
	const runtimeLines = $derived.by(() => {
		const { since, until } = release_window(releases, releaseAt);
		return [...(data.logs ?? [])]
			.filter(
				(row) => (since === undefined || row.at >= since) && (until === undefined || row.at < until)
			)
			.reverse()
			.map((row) => ({
				id: row.id,
				at: row.at,
				level: row.severity,
				message: `${row.event} ${JSON.stringify(row.attributes)}`,
				source: row.run === null ? null : `run ${row.run}`
			}));
	});
	const host = $derived(ctx.ui.kinds);
	const when = (value: string | null) =>
		value === null ? t('Not recorded') : new Date(value).toLocaleString(host.locale);
	const bytes = (value: number | null) => format_metric_value('bytes', value, host.locale);
	const TABS = {
		bundle: { title: 'Bundle', icon: 'lucide:package' },
		telemetry: { title: 'Telemetry', icon: 'lucide:activity' },
		logs: { title: 'Runtime & runs', icon: 'lucide:scroll-text' },
		users: { title: 'Users', icon: 'lucide:users' },
		activity: { title: 'Activity', icon: 'lucide:mouse-pointer-click' },
		improvements: { title: 'Improvements', icon: 'lucide:wrench' }
	} as const;
	const BODIES = { bundle, telemetry, logs: runtime, users, activity, improvements };
	const pageRows = $derived(
		[...(data.activity?.pages ?? [])]
			.sort((a, b) => b.views - a.views)
			.map((row) => ({
				id: row.route,
				route: row.route,
				views: row.views,
				people: row.people,
				dwell:
					row.dwell_ms === null
						? t('Not recorded')
						: format_metric_value('seconds', row.dwell_ms / 1000, host.locale)
			}))
	);
	const ACCESS: { readonly [audience: string]: string } = {
		staff: 'Norbius (staff)',
		member: 'Norbius (member)',
		channel: 'Envoy',
		system: 'System agent'
	};
	const cost = (value: number) =>
		new Intl.NumberFormat(host.locale, {
			style: 'currency',
			currency: 'USD',
			maximumFractionDigits: 4
		}).format(value);
	const turnRows = $derived(
		(data.activity?.turns ?? []).map((row) => ({
			id: row.audience,
			used_by: t(ACCESS[row.audience] ?? row.audience),
			turns: row.turns,
			failed: row.failed,
			steps: row.steps,
			tool_errors: row.tool_errors,
			cost: cost(row.cost)
		}))
	);
	const THREAD_STATUS: {
		readonly [status: string]: { label: string; variant: BadgeVariant; lane: string };
	} = {
		open: { label: 'Open', variant: 'outline', lane: 'open' },
		working: { label: 'Agent working', variant: 'info', lane: 'working' },
		blocked: { label: 'Needs your answer', variant: 'warning', lane: 'blocked' },
		ready: { label: 'Ready to merge', variant: 'success', lane: 'ready' },
		merged: { label: 'Merged', variant: 'brand', lane: 'done' },
		platform: { label: 'Platform fault', variant: 'outline', lane: 'done' },
		dismissed: { label: 'Dismissed', variant: 'outline', lane: 'done' }
	};
	// the board's lanes, in the order a thread moves; `working` is what an agent is on now
	const LANES = [
		{ value: 'open', label: 'Open', dot: 'bg-muted-foreground/60' },
		{
			value: 'working',
			label: 'Agent working',
			dot: 'bg-info animate-pulse motion-reduce:animate-none'
		},
		{ value: 'blocked', label: 'Needs your answer', dot: 'bg-warning' },
		{ value: 'ready', label: 'Ready to merge', dot: 'bg-success' },
		{ value: 'done', label: 'Closed', dot: 'bg-muted-foreground/30' }
	] as const;
	const boardLanes = $derived(
		LANES.map((lane) => ({ value: lane.value, label: t(lane.label), dot: lane.dot }))
	);
	const KIND = { feedback: 'Feedback', request: 'Request', failure: 'Failing automation' } as const;
	const threadRows = $derived(
		(data.improvements?.threads ?? []).map((thread) => {
			const status = THREAD_STATUS[thread.status];
			return {
				...thread,
				kind: t(KIND[thread.kind]),
				status: t(status?.label ?? thread.status),
				variant: status?.variant ?? 'outline',
				lane: status?.lane ?? 'open',
				updated: when(thread.updated_at)
			};
		})
	);

	// Group telemetry KPI charts into focused domain tabs so operators never scroll a wall of 18+ charts.
	type TelemetryChart = WorkspaceOperationsData['usage'][number];
	type TelemetryBucket = 'runtime' | 'ai' | 'storage' | 'schedules' | 'other';
	const isBucket = (value: string | undefined): value is TelemetryBucket =>
		value === 'runtime' ||
		value === 'ai' ||
		value === 'storage' ||
		value === 'schedules' ||
		value === 'other';
	const classifyChart = (chart: TelemetryChart): TelemetryBucket => {
		if (isBucket(chart.group)) return chart.group;
		const lower = chart.title.toLowerCase();
		if (chart.unit === 'micro-SGD' || /\bai\b/.test(lower)) return 'ai';
		if (lower.startsWith('cron')) return 'schedules';
		if (
			chart.unit === 'bytes' ||
			lower.includes('storage') ||
			lower.includes('database') ||
			lower.includes('disk') ||
			lower.includes('worktree') ||
			lower.includes('checkout') ||
			lower.includes('package store') ||
			lower.includes('sandbox') ||
			lower.includes('release cache') ||
			lower.includes('builds and artifacts')
		)
			return 'storage';
		if (
			lower.includes('memory') ||
			lower.includes('compute') ||
			lower.includes('cpu') ||
			lower.includes('browser') ||
			lower.includes('online') ||
			lower.includes('view') ||
			lower.includes('waiting') ||
			lower.includes('job') ||
			lower.includes('log')
		)
			return 'runtime';
		return 'other';
	};
	const TELEMETRY_GROUPS: readonly {
		readonly name: TelemetryBucket;
		readonly title: string;
		readonly icon: string;
	}[] = [
		{ name: 'runtime', title: 'Runtime', icon: 'lucide:cpu' },
		{ name: 'ai', title: 'AI', icon: 'lucide:sparkles' },
		{ name: 'storage', title: 'Storage', icon: 'lucide:hard-drive' },
		{ name: 'schedules', title: 'Schedules', icon: 'lucide:clock' },
		{ name: 'other', title: 'Other', icon: 'lucide:activity' }
	];
	const telemetryTabs = $derived.by(() => {
		const buckets = new Map<TelemetryBucket, TelemetryChart[]>();
		for (const chart of data.usage) {
			const bucket = classifyChart(chart);
			const list = buckets.get(bucket);
			if (list === undefined) buckets.set(bucket, [chart]);
			else list.push(chart);
		}
		return TELEMETRY_GROUPS.flatMap((group) => {
			const charts = buckets.get(group.name);
			return charts === undefined || charts.length === 0 ? [] : [{ ...group, charts }];
		});
	});
	const activeTelemetryGroup = $derived(
		telemetryGroup !== undefined && telemetryTabs.some((group) => group.name === telemetryGroup)
			? telemetryGroup
			: telemetryTabs[0]?.name
	);
</script>

<!-- fills a bounded parent: tables, boards and chart grids scroll inside themselves -->
<div
	class="@container flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 text-xs"
	aria-busy={busy}
	data-workspace-operations
>
	{#if data.errors?.studio}<p role="alert" class="shrink-0 text-destructive">
			{data.errors.studio}
		</p>{/if}
	{#if views.length === 1}
		{@render BODIES[view]()}
	{:else}
		<Tabs
			value={view}
			class="min-h-0 flex-1 gap-3"
			on_value_change={(next) => {
				const picked = views.find((v) => v === next);
				if (picked !== undefined) on_change({ view: picked });
			}}
			tabs={views.map((name) => ({
				name,
				...TABS[name],
				title: t(TABS[name].title),
				body: BODIES[name]
			}))}
		/>
	{/if}
</div>
{#snippet restricted()}
	<div
		class="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-4 text-muted-foreground"
	>
		<Icon name="lucide:lock-keyhole" class="size-4 shrink-0" />
		<p>
			{data.errors?.access ??
				t('Workspace administrator access is required to inspect these details.')}
		</p>
	</div>
{/snippet}
{#snippet ranges()}
	<nav aria-label={t('Trend range')} class="flex shrink-0 gap-1">
		{#each ['24h', '7d', '30d'] as item (item)}<Button
				variant={range === item ? 'secondary' : 'ghost'}
				class="h-8 px-2.5 text-xs"
				onclick={() => on_change({ range: item === '24h' || item === '30d' ? item : '7d' })}
				>{item}</Button
			>{/each}
	</nav>
{/snippet}
{#snippet unserved()}
	{#if can_inspect}<p class="text-meta">{t('This host does not serve this view.')}</p
		>{:else}{@render restricted()}{/if}
{/snippet}
{#snippet routeCell({ row }: { row: (typeof pageRows)[number]; value: unknown })}
	<span class="font-mono text-xs">{row.route}</span>
{/snippet}
{#snippet monoCell({ value }: { row: object; value: unknown })}
	<span class="font-mono text-xs">{String(value ?? '')}</span>
{/snippet}
{#snippet memberNameCell({ row }: { row: (typeof memberRows)[number]; value: unknown })}
	<div class="min-w-0">
		<div class="truncate font-medium">{row.name}</div>
		<div class="text-meta truncate font-mono">{row.id}</div>
	</div>
{/snippet}
{#snippet memberStatusCell({ row }: { row: (typeof memberRows)[number]; value: unknown })}
	<Badge variant={row.active ? 'outline' : 'default'} class={!row.active ? 'opacity-70' : undefined}
		>{row.status}</Badge
	>
{/snippet}
{#snippet activity()}
	{@const use = data.activity}
	{#if use === null}{@render unserved()}{:else}
		<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3">
			<div class="flex shrink-0 flex-wrap items-center justify-between gap-3">
				<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
					<h2 class="text-sm font-semibold">{t('Activity')}</h2>
					{#if !(use.people === 0 && use.pages.length === 0 && use.turns.length === 0)}
						<span class="text-meta tabular-nums"
							>{t('People who opened a page')}: {use.people}</span
						>
					{/if}
				</div>
				{@render ranges()}
			</div>
			{#if use.people === 0 && use.pages.length === 0 && use.turns.length === 0}
				<EmptyState
					variant="inset"
					size="fill"
					icon="history"
					title={t('No activity recorded in this range.')}
				/>
			{:else}
				<div class="flex min-h-0 flex-1 flex-col">
					<Table
						{ctx}
						of={pageRows}
						key="activity-pages"
						layout="grid"
						toolbar={{
							title: t('Pages'),
							description: false,
							filter: false,
							export: false,
							select: false,
							new: false
						}}
						columns={[
							{ field: 'route', label: t('Page'), cell: routeCell },
							{ field: 'views', label: t('Views'), align: 'end', width: 96 },
							{ field: 'people', label: t('People'), align: 'end', width: 96 },
							{ field: 'dwell', label: t('Average time open'), align: 'end', width: 175 }
						]}
					/>
				</div>
				{#if turnRows.length > 0}
					<section class="flex shrink-0 flex-col gap-1.5" aria-label={t('Assistant activity')}>
						<h3 class="text-xs font-semibold text-foreground">{t('Assistant activity')}</h3>
						<Table
							{ctx}
							of={turnRows}
							key="activity-turns"
							controlled
							embedded
							toolbar={false}
							columns={[
								{ field: 'used_by', label: t('Used by') },
								{ field: 'turns', label: t('Turns'), align: 'end', width: 84 },
								{ field: 'failed', label: t('Failed'), align: 'end', width: 84 },
								{ field: 'steps', label: t('Steps'), align: 'end', width: 84 },
								{ field: 'tool_errors', label: t('Tool errors'), align: 'end', width: 100 },
								{ field: 'cost', label: t('Cost'), align: 'end', width: 110 }
							]}
						/>
					</section>
				{/if}
			{/if}
		</div>
	{/if}
{/snippet}
{#snippet improvements()}
	{#if data.improvements === null}{@render unserved()}{:else}
		<div class="flex h-full min-h-0 flex-1 flex-col gap-2" data-improvement-board>
			<div class="flex min-h-0 flex-1 flex-col">
				<LocalBoard
					{ctx}
					of={threadRows}
					by="lane"
					lanes={boardLanes}
					columns={5}
					fields={[
						{ field: 'title', label: t('Subject') },
						{ field: 'kind', label: t('Source') },
						{ field: 'status', label: t('Status') },
						{ field: 'last', label: t('Latest') }
					]}
					key="improvements"
					toolbar={{
						title: t('Improvements'),
						description: t(
							'Feedback, requests and automations that keep failing. Turn automatic improvement on or off in Settings → Organization → Assistant.'
						)
					}}
					can_open={(row) => row.conversation !== null && on_conversation !== undefined}
					on_open={(row) => {
						if (row.conversation !== null) on_conversation?.(row.conversation);
					}}
				>
					{#snippet card({ row, lane })}
						<div class="contents" data-improvement={row.id}>
							<span class="flex items-center justify-between gap-2">
								<Badge variant="outline">{row.kind}</Badge>
								{#if row.change !== null}<span class="text-xs text-muted-foreground tabular-nums"
										>!{row.change}</span
									>{/if}
							</span>
							<span class="line-clamp-2 font-medium">{row.title}</span>
							{#if row.last !== null}<span class="text-meta line-clamp-2">{row.last}</span>{/if}
							<span class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
								{#if lane.value === 'done'}<Badge variant={row.variant}>{row.status}</Badge>{/if}
								<span class="tabular-nums">{t('Reported')} {row.seen}×</span>
								<span>{row.updated}</span>
							</span>
						</div>
					{/snippet}
				</LocalBoard>
			</div>
			<p class="text-meta shrink-0">
				{t('Reply to one or dismiss it by asking Norbius. Merge ready commits in Studio.')}
			</p>
		</div>
	{/if}
{/snippet}
{#snippet telemetry()}
	<div class="flex h-full min-h-0 flex-1 flex-col gap-3">
		{#if telemetryTabs.length === 0}
			<div class="flex shrink-0 flex-wrap items-center justify-between gap-3">
				<h2 class="text-sm font-semibold">{t('Telemetry')}</h2>
				{@render ranges()}
			</div>
			<EmptyState variant="inset" size="fill" icon="history" title={t('No telemetry recorded.')} />
		{:else}
			<Tabs
				value={activeTelemetryGroup}
				class="min-h-0 flex-1 gap-3"
				trailing={ranges}
				on_value_change={(next) => {
					telemetryGroup = next;
				}}
				tabs={telemetryTabs.map((group) => ({
					name: group.name,
					title: t(group.title),
					icon: group.icon,
					count: group.charts.length,
					body: telemetryGroupBody
				}))}
			/>
		{/if}
	</div>
{/snippet}
{#snippet telemetryGroupBody()}
	{@const active = telemetryTabs.find((group) => group.name === activeTelemetryGroup)}
	{#if active !== undefined}
		<Scroll name={`telemetry-${active.name}`} size="fill">
			<div class="grid gap-3 pb-2 @2xl:grid-cols-2 @5xl:grid-cols-3">
				{#each active.charts as chart (chart.title)}<UsageChart
						{ctx}
						title={chart.title}
						description={chart.description}
						aggregation={chart.aggregation}
						unit={chart.unit}
						lines={chart.lines}
						utilization={chart.utilization}
					/>{/each}
			</div>
		</Scroll>
	{/if}
{/snippet}
{#snippet bundle()}
	{#if !can_inspect}{@render restricted()}{:else}<Scroll name="bundle" size="fill" layout="stack" gap="md">
		<section class="grid min-w-0 gap-3" aria-labelledby="workspace-bundle-health">
			<h3 id="workspace-bundle-health" class="text-sm font-semibold">
				{t('Bundle')}
			</h3>
			{#if bundles}<p class="text-meta">
					{bundles.commit
						? `${t('Build')} ${bundles.commit.slice(0, 12)}`
						: t('Current live release')} · {t(
						bundles.live ? 'Serving live' : 'Retained build artifact'
					)}
				</p>{:else if studio?.build}<p class="text-meta">
					{t(
						studio.build.build.status === 'failed'
							? 'This build failed; no retained bundle is available.'
							: 'This build’s retained artifact is unavailable.'
					)}
				</p>{/if}
			{#if data.errors?.bundles}<p role="alert" class="text-destructive">
					{data.errors.bundles}
				</p>{/if}
			<dl class="grid gap-4 border-b border-border pb-3 @xl:grid-cols-2">
				<div>
					<dt class="text-meta">{t(bundles?.live ? 'Live artifact' : 'Selected build artifact')}</dt>
					<dd class="mt-1 truncate font-mono" title={bundles?.digest}>
						{bundles?.digest.slice(0, 16) ?? t('Unavailable')}
					</dd>
				</div>
				<div>
					<dt class="text-meta">{t('Artifact bytes')}</dt>
					<dd class="mt-1 font-medium tabular-nums">{bytes(data.health?.artifact_bytes ?? null)}</dd>
				</div>
				<div>
					<dt class="text-meta">{t('Public client bytes')}</dt>
					<dd class="mt-1 font-medium tabular-nums">{bytes(bundles?.total_bytes ?? null)}</dd>
				</div>
				<div>
					<dt class="text-meta">{t('Referenced cache bytes')}</dt>
					<dd class="mt-1 font-medium tabular-nums">
						{bundles?.asset_count === null ? t('Unavailable') : bytes(cache?.release_bytes ?? null)}
					</dd>
				</div>
			</dl>
			{#each data.health?.errors ?? [] as error, index (index)}<p class="text-meta">{error}</p>{/each}
			{#if cache}<p class="text-meta">
					{t('Shared host cache')}:
					<span class="font-mono">{bytes(cache.host_bytes)} / {bytes(cache.budget_bytes)}</span>
					· {cache.release_entries}
					{t('entries referenced by this release')}
				</p>{/if}
			{#if data.errors?.cache}<p role="alert" class="text-destructive">{data.errors.cache}</p>{/if}
			<details class="rounded-md border border-border p-3">
				<summary class="cursor-pointer font-medium"
					>{t('Recorded package versions')} · {data.health?.packages.length ?? 0}</summary
				>
				<div class="mt-2 h-72">
					<Table
						{ctx}
						of={packageRows}
						key="packages"
						toolbar={{ title: false, description: false, export: false, select: false, new: false }}
						columns={[
							{ field: 'name', label: t('Package'), cell: monoCell },
							{ field: 'version', label: t('Version'), cell: monoCell, width: 120 },
							{ field: 'source_text', label: t('Recorded in'), width: 120 }
						]}
					/>
				</div>
			</details>
			<details class="rounded-md border border-border p-3">
				<summary class="cursor-pointer font-medium"
					>{t('Bundle files')} · {bundles?.asset_count ?? t('Unavailable')}</summary
				>
				<div class="mt-2 h-80">
					<Table
						{ctx}
						of={assetRows}
						key="assets"
						toolbar={{ title: false, description: false, export: false, select: false, new: false }}
						columns={[
							{ field: 'path', label: t('Client asset'), cell: monoCell },
							{ field: 'size_text', label: t('On disk'), align: 'end', width: 110 },
							{ field: 'variants', label: t('Cached variants'), cell: monoCell, width: 160 }
						]}
					/>
				</div>
				{#if bundles?.truncated}<p class="text-meta mt-2">
						{t(
							'Only the first 200 client assets are listed. Client byte totals are unavailable when the list is truncated.'
						)}
					</p>{/if}
			</details>
		</section>
	</Scroll>{/if}
{/snippet}
{#snippet runtime()}
	{#if !can_inspect}{@render restricted()}{:else}<div class="flex h-full min-h-0 flex-1 flex-col gap-3">
			{#if data.errors?.logs}<p role="alert" class="text-destructive">
					{data.errors.logs}
				</p>{/if}<LogView {ctx} rows={runtimeLines} follow={false} trailing={actions}>
				{#snippet controls()}
					<h2 class="px-1 text-sm font-semibold">{t('Runtime & run logs')}</h2>
					<Combobox
						class="w-80"
						aria-label={t('Release')}
						searchable
						value={releaseAt ?? ''}
						options={releaseOptions}
						on_change={(at) => at !== null && (release = at || null)}
					/>
					<Combobox
						class="w-64"
						aria-label={t('Automation run')}
						searchable
						value={data.filters.run}
						options={runOptions}
						on_search={(query) => {
							runSearch = query;
						}}
						on_change={(run) => run !== null && on_change({ run: run || null })}
					/>
				{/snippet}
				{#snippet empty()}
					<EmptyState
						variant="inset"
						size="fill"
						icon="history"
						title={t(releaseAt === null ? 'No log lines' : 'No log lines in this release')}
						hint={t('Automation runs, assistant turns and envoy messages write here.')}
					/>
				{/snippet}
			</LogView>
		</div>{/if}
{/snippet}
{#snippet userCount()}<span class="text-meta"
		>{memberRows.length}
		{t('users')} · {memberRows.filter((member) => member.status === t(STATUS.recent)).length}
		{t('recently active')}</span
	>{/snippet}
{#snippet users()}
	{#if members === null}{#if can_inspect}<p class="text-meta">
				{data.errors?.access ?? t('The named user inventory is unavailable.')}
			</p>{:else}{@render restricted()}{/if}{:else}
		<div class="flex h-full min-h-0 flex-1 flex-col">
			<Table
				{ctx}
				of={memberRows}
				key="users"
				toolbar={{
					title: t('Users'),
					description: false,
					trailing: userCount,
					export: false,
					select: false,
					new: false
				}}
				columns={[
					{ field: 'name', label: t('User'), cell: memberNameCell },
					{ field: 'email_text', label: t('Email / login identity') },
					{ field: 'status', label: t('Status'), cell: memberStatusCell, width: 140 },
					{ field: 'last_seen_text', label: t('Last authenticated activity'), width: 215 }
				]}
			/>
		</div>
	{/if}
{/snippet}
