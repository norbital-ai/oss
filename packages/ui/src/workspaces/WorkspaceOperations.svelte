<!--
@component
A workspace's operations panel: bundle, telemetry, logs, users, activity and improvements views over data its owner reads
for the chosen scope.
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
	import CustomView from '../model/CustomView.svelte';
	import EmptyState from '../primitives/empty-state/EmptyState.svelte';
	import LogView from '../logs/LogView.svelte';
	import UsageChart, { format_metric_value } from '../chart/UsageChart.svelte';
	import { memberStatus, newestReleases, release_window } from './filters.js';
	import { words_of } from '../client/context.js';
	import { msg } from '../text/messages.js';
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
			status: t(STATUS[memberStatus(member, data.as_of)])
		}))
	);
	const cacheByPath = $derived(new Map((cache?.assets ?? []).map((asset) => [asset.path, asset])));
	const assetRows = $derived(
		(bundles?.assets ?? []).map((asset) => {
			const held = cacheByPath.get(asset.path);
			return {
				...asset,
				id: asset.path,
				variants: held?.variants.map((variant) => variant.encoding).join(', ') || t('Not resident')
			};
		})
	);
	const packageRows = $derived(
		(data.health?.packages ?? []).map((pkg) => ({ ...pkg, id: `${pkg.source}:${pkg.name}` }))
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
	const pageRows = $derived([...(data.activity?.pages ?? [])].sort((a, b) => b.views - a.views));
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
		{ key: 'open', label: 'Open', dot: 'bg-muted-foreground/60' },
		{ key: 'working', label: 'Agent working', dot: 'bg-info animate-pulse motion-reduce:animate-none' },
		{ key: 'blocked', label: 'Needs your answer', dot: 'bg-warning' },
		{ key: 'ready', label: 'Ready to merge', dot: 'bg-success' },
		{ key: 'done', label: 'Closed', dot: 'bg-muted-foreground/30' }
	] as const;
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
</script>

<!-- fills a bounded parent: on a wide container Bundle's details scroll in place -->
<div
	class="@container flex min-h-0 min-w-0 flex-1 flex-col gap-3 text-xs"
	aria-busy={busy}
	data-workspace-operations
>
	{#if data.errors?.studio}<p role="alert" class="text-destructive">{data.errors.studio}</p>{/if}
	{#if views.length === 1}
		{@render BODIES[view]()}
	{:else}
		<Tabs
			value={view}
			class="gap-3"
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
	<nav aria-label={t('Trend range')} class="flex gap-1">
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
{#snippet activity()}
	{@const use = data.activity}
	{#if use === null}{@render unserved()}{:else}<div class="grid min-w-0 gap-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<h2 class="text-sm font-semibold">{t('Activity')}</h2>
				{@render ranges()}
			</div>
			{#if use.people === 0 && use.pages.length === 0 && use.turns.length === 0}<p
					class="text-meta"
				>
					{t('No activity recorded in this range.')}
				</p>{:else}<p>{t('People who opened a page')}: {use.people}</p>
				<h3 class="font-semibold">{t('Pages')}</h3>
				<div class="overflow-x-auto rounded-md border border-border px-3">
					<table class="w-full text-left">
						<thead
							><tr
								><th scope="col">{t('Page')}</th><th scope="col">{t('Views')}</th><th scope="col"
									>{t('People')}</th
								><th scope="col">{t('Average time open')}</th></tr
							></thead
						><tbody
							>{#each pageRows as row (row.route)}<tr
									><th scope="row" class="max-w-md break-all font-mono font-normal">{row.route}</th
									><td class="tabular-nums">{row.views}</td><td class="tabular-nums"
										>{row.people}</td
									><td class="whitespace-nowrap tabular-nums"
										>{row.dwell_ms === null
											? t('Not recorded')
											: format_metric_value('seconds', row.dwell_ms / 1000, host.locale)}</td
									></tr
								>{/each}</tbody
						>
					</table>
				</div>
				<h3 class="font-semibold">{t('Assistant activity')}</h3>
				<div class="overflow-x-auto rounded-md border border-border px-3">
					<table class="w-full text-left">
						<thead
							><tr
								><th scope="col">{t('Used by')}</th><th scope="col">{t('Turns')}</th><th
									scope="col">{t('Failed')}</th
								><th scope="col">{t('Steps')}</th><th scope="col">{t('Tool errors')}</th><th
									scope="col">{t('Cost')}</th
								></tr
							></thead
						><tbody
							>{#each use.turns as row (row.audience)}<tr
									><th scope="row" class="font-medium">{t(ACCESS[row.audience] ?? row.audience)}</th
									><td class="tabular-nums">{row.turns}</td><td class="tabular-nums"
										>{row.failed}</td
									><td class="tabular-nums">{row.steps}</td><td class="tabular-nums"
										>{row.tool_errors}</td
									><td class="whitespace-nowrap tabular-nums">{cost(row.cost)}</td></tr
								>{/each}</tbody
						>
					</table>
				</div>{/if}
		</div>{/if}
{/snippet}
{#snippet improvements()}
	{#if data.improvements === null}{@render unserved()}{:else}<div class="flex min-h-0 flex-1 flex-col gap-3">
			<CustomView
				{ctx}
				of={threadRows}
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
						'Feedback, requests and automations that keep failing. Turn automatic improvement on or off in Settings, under Assistant.'
					)
				}}
				empty={false}
			>
				{#snippet children(shown)}
					<!-- five lanes side by side, each scrolling its own cards; a narrow panel scrolls them sideways -->
					<div
						class="grid h-full min-h-0 grid-cols-[repeat(5,minmax(14rem,1fr))] gap-3 overflow-x-auto pb-2"
						data-improvement-board
					>
						{#each LANES as lane (lane.key)}
							{@const cards = shown.filter((row) => row.lane === lane.key)}
							<section
								aria-label={t(lane.label)}
								class="flex min-h-0 min-w-0 flex-col gap-2 rounded-control border border-border-lane bg-surface-lane p-3"
								data-lane={lane.key}
							>
								<header class="flex items-center gap-1.5 border-b pb-2 text-sm font-medium dark:border-b-0 dark:pb-0">
									<span class={['size-2 shrink-0 rounded-full', lane.dot]} aria-hidden="true"></span>
									<span class="truncate">{t(lane.label)}</span>
									<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{cards.length}</span>
								</header>
								{#if cards.length === 0}<p class="py-6 text-center text-sm text-muted-foreground">
										{msg(words_of(ctx), 'board.laneEmpty')}
									</p>{:else}<ul class="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1">
										{#each cards as card (card.id)}
											<li>
												{#if card.conversation !== null && on_conversation !== undefined}<button
														type="button"
														onclick={() => card.conversation !== null && on_conversation(card.conversation)}
														class="flex w-full cursor-pointer flex-col gap-1 rounded-control border bg-surface-raised p-2.5 text-left text-sm transition-colors hover:border-border-control focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none motion-reduce:transition-none"
														data-improvement={card.id}>{@render threadCard(card, lane.key)}</button
													>{:else}<div
														class="flex flex-col gap-1 rounded-control border bg-surface-raised p-2.5 text-sm"
														data-improvement={card.id}
													>
														{@render threadCard(card, lane.key)}
													</div>{/if}
											</li>
										{/each}
									</ul>{/if}
							</section>
						{/each}
					</div>
				{/snippet}
			</CustomView>
			<p class="text-meta">
				{t('Reply to one or dismiss it by asking Norbius. Merge ready commits in Studio.')}
			</p>
		</div>{/if}
{/snippet}
{#snippet threadCard(card: (typeof threadRows)[number], lane: string)}
	<span class="flex items-center justify-between gap-2">
		<Badge variant="outline">{card.kind}</Badge>
		{#if card.change !== null}<span class="text-xs text-muted-foreground tabular-nums">!{card.change}</span>{/if}
	</span>
	<span class="line-clamp-2 font-medium">{card.title}</span>
	{#if card.last !== null}<span class="text-meta line-clamp-2">{card.last}</span>{/if}
	<span class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
		{#if lane === 'done'}<Badge variant={card.variant}>{card.status}</Badge>{/if}
		<span class="tabular-nums">{t('Reported')} {card.seen}×</span>
		<span>{card.updated}</span>
	</span>
{/snippet}
{#snippet telemetry()}
	<div class="grid gap-3">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 class="text-sm font-semibold">{t('Telemetry')}</h2>
			{@render ranges()}
		</div>
		<div class="grid gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
			{#each data.usage as chart (chart.title)}<UsageChart {ctx} {...chart} />{/each}
		</div>
	</div>
{/snippet}
{#snippet bundle()}
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
			<CustomView
				{ctx}
				of={packageRows}
				fields={[
					{ field: 'name', label: t('Package') },
					{ field: 'version', label: t('Version') },
					{ field: 'source', label: t('Recorded in') }
				]}
				key="packages"
				toolbar={{ title: false, description: false }}
			>
				{#snippet children(shown)}
					<div class="overflow-x-auto">
						<table class="w-full text-left">
							<thead
								><tr
									><th scope="col">{t('Package')}</th><th scope="col">{t('Version')}</th><th
										scope="col">{t('Recorded in')}</th
									></tr
								></thead
							><tbody
								>{#each shown as pkg (pkg.id)}<tr
										><th scope="row" class="font-mono font-normal">{pkg.name}</th><td class="font-mono"
											>{pkg.version}</td
										><td class="text-meta">{t(pkg.source)}</td></tr
									>{/each}</tbody
							>
						</table>
					</div>
				{/snippet}
			</CustomView>
		</details>
		<details class="rounded-md border border-border p-3">
			<summary class="cursor-pointer font-medium"
				>{t('Bundle files')} · {bundles?.asset_count ?? t('Unavailable')}</summary
			>
			<CustomView
				{ctx}
				of={assetRows}
				fields={[
					{ field: 'path', label: t('Client asset') },
					{ field: 'sha256', label: 'SHA-256' },
					{ field: 'bytes', label: t('On disk') },
					{ field: 'variants', label: t('Cached variants') }
				]}
				key="assets"
				toolbar={{ title: false, description: false }}
			>
				{#snippet children(shown)}
					<div class="overflow-x-auto">
						<table class="w-full text-left">
							<thead
								><tr
									><th scope="col">{t('Client asset')}</th><th scope="col">{t('On disk')}</th><th
										scope="col">{t('Cached variants')}</th
									></tr
								></thead
							><tbody
								>{#each shown as asset (asset.id)}<tr
										><th scope="row" class="max-w-md break-all font-mono font-normal">{asset.path}</th
										><td class="whitespace-nowrap font-mono">{bytes(asset.bytes)}</td><td
											class="font-mono">{asset.variants}</td
										></tr
									>{/each}</tbody
							>
						</table>
					</div>
				{/snippet}
			</CustomView>
			{#if bundles?.truncated}<p class="text-meta mt-2">
					{t(
						'Only the first 200 client assets are listed. Client byte totals are unavailable when the list is truncated.'
					)}
				</p>{/if}
		</details>
	</section>
{/snippet}
{#snippet runtime()}
	{#if !can_inspect}{@render restricted()}{:else}<div class="flex min-h-0 flex-1 flex-col gap-3">
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
			</p>{:else}{@render restricted()}{/if}{:else}<CustomView
			{ctx}
			of={memberRows}
			fields={[
				{ field: 'name', label: t('User') },
				{ field: 'email', label: t('Email / login identity') },
				{ field: 'id', label: 'ID' },
				{ field: 'status', label: t('Status') },
				{ field: 'last_seen', label: t('Last authenticated activity') }
			]}
			key="users"
			toolbar={{ title: t('Users'), description: false, trailing: userCount }}
		>
			{#snippet children(shown)}
				<div class="overflow-x-auto rounded-md border border-border px-3">
					<table class="w-full text-left">
						<thead
							><tr
								><th scope="col">{t('User')}</th><th scope="col">{t('Email / login identity')}</th><th
									scope="col">{t('Status')}</th
								><th scope="col">{t('Last authenticated activity')}</th></tr
							></thead
						><tbody
							>{#each shown as member (member.id)}<tr
									><th scope="row" class="font-medium"
										>{member.name}
										<div class="text-meta font-mono">{member.id}</div></th
									><td>{member.email ?? t('Not recorded')}</td><td
										><span
											class={`inline-flex rounded px-2 py-0.5 text-micro ${!member.active ? 'bg-muted text-muted-foreground' : 'text-foreground'}`}
											>{member.status}</span
										></td
									><td class="whitespace-nowrap">{when(member.last_seen)}</td></tr
								>{/each}</tbody
						>
					</table>
				</div>
			{/snippet}
		</CustomView>{/if}
{/snippet}

<style>
	th,
	td {
		padding: 0.75rem 1rem 0.75rem 0;
		vertical-align: top;
	}
	thead {
		color: var(--muted-foreground);
	}
	thead th {
		font-weight: 400;
		white-space: nowrap;
	}
	tbody tr {
		border-top: 1px solid var(--border);
	}
</style>
