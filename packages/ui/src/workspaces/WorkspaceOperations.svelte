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
		data: WorkspaceOperationsData;
		range: WorkspaceRange;
		view: WorkspaceView;
		/** The views to offer, in order (all four by default); with one, it renders without its own tab strip. */
		views?: readonly WorkspaceView[];
		busy?: boolean;
		on_change: (next: WorkspaceScope) => void;
		t?: (key: string) => string;
		/**
		 * The release whose logs Logs shows, by its publication instant (`at`): omitted, the serving release; `null`, every
		 * release. Bind it to read the selection (the owner scopes its own log read to `release_window`).
		 */
		release?: string | null | undefined;
		/** Trailing controls on the Logs header line (an Auto-refresh toggle). */
		actions?: Snippet;
	};
</script>

<script lang="ts">
	import Button from '../primitives/button/button.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import Tabs from '../primitives/tabs/tabs.svelte';
	import ToolbarSearch from '../model/toolbar/ToolbarSearch.svelte';
	import ToolbarFilter from '../model/toolbar/ToolbarFilter.svelte';
	import LogView from '../logs/LogView.svelte';
	import UsageChart, { format_metric_value } from '../chart/UsageChart.svelte';
	import { filterMembers, newestReleases, release_window } from './filters.js';
	let {
		ctx,
		data,
		range,
		view,
		views = ['bundle', 'telemetry', 'logs', 'users'],
		busy = false,
		on_change,
		t = (key) => key,
		release = $bindable(),
		actions
	}: WorkspaceOperationsProps = $props();
	let userSearch = $state(''),
		userStatus = $state('all');
	let assetSearch = $state(''),
		assetStatus = $state('all'),
		runSearch = $state(''),
		packageSearch = $state('');
	const can_inspect = $derived(data.can_inspect);
	const studio = $derived(data.studio),
		members = $derived(data.members),
		bundles = $derived(data.bundles),
		cache = $derived(data.cache);
	const shownMembers = $derived(filterMembers(members ?? [], userSearch, userStatus, data.as_of));
	const cacheByPath = $derived(new Map((cache?.assets ?? []).map((asset) => [asset.path, asset])));
	const shownAssets = $derived(
		(bundles?.assets ?? []).filter(
			(asset) =>
				`${asset.path} ${asset.sha256}`.toLowerCase().includes(assetSearch.trim().toLowerCase()) &&
				(assetStatus === 'all' ||
					(cache !== null &&
						(assetStatus === 'cached'
							? (cacheByPath.get(asset.path)?.cached_bytes ?? 0) > 0
							: (cacheByPath.get(asset.path)?.cached_bytes ?? 0) === 0)))
		)
	);
	const shownPackages = $derived(
		(data.health?.packages ?? []).filter((pkg) =>
			`${pkg.name} ${pkg.version}`.toLowerCase().includes(packageSearch.trim().toLowerCase())
		)
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
	// Logs reads one release: the serving one unless another (or every one, `null`) is chosen
	const releases = $derived(newestReleases(studio?.releases ?? []));
	const releaseAt = $derived(
		release === undefined ? (releases.find((r) => r.current)?.at ?? null) : release
	);
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
				...(row.run === null ? {} : { source: `run ${row.run}` })
			}));
	});
	const host = $derived(ctx.ui.kinds);
	const when = (value: string | null) =>
		value === null ? t('Not recorded') : new Date(value).toLocaleString(host.locale);
	const online = (value: string | null) =>
		value !== null && Date.parse(value) > Date.parse(data.as_of) - 300000;
	const bytes = (value: number | null) => format_metric_value('bytes', value, host.locale);
	const TABS = {
		bundle: { title: 'Bundle', icon: 'lucide:package' },
		telemetry: { title: 'Telemetry', icon: 'lucide:activity' },
		logs: { title: 'Runtime & runs', icon: 'lucide:scroll-text' },
		users: { title: 'Users', icon: 'lucide:users' }
	} as const;
	const BODIES = { bundle, telemetry, logs: runtime, users };
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
{#snippet telemetry()}
	<div class="grid gap-3">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 class="text-sm font-semibold">{t('Telemetry')}</h2>
			<nav aria-label={t('Trend range')} class="flex gap-1">
				{#each ['24h', '7d', '30d'] as item (item)}<Button
						variant={range === item ? 'secondary' : 'ghost'}
						class="h-8 px-2.5 text-xs"
						onclick={() => on_change({ range: item === '24h' || item === '30d' ? item : '7d' })}
						>{item}</Button
					>{/each}
			</nav>
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
			<div class="mt-2 flex items-center gap-1" data-view-toolbar>
				<ToolbarSearch bind:value={packageSearch} label={t('Search package names and versions')} />
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-left">
					<thead
						><tr
							><th scope="col">{t('Package')}</th><th scope="col">{t('Version')}</th><th scope="col"
								>{t('Recorded in')}</th
							></tr
						></thead
					><tbody
						>{#each shownPackages as pkg (`${pkg.source}:${pkg.name}`)}<tr
								><th scope="row" class="font-mono font-normal">{pkg.name}</th><td class="font-mono"
									>{pkg.version}</td
								><td class="text-meta">{t(pkg.source)}</td></tr
							>{:else}<tr
								><td colspan="3" class="text-meta"
									>{t('No recorded package versions are available.')}</td
								></tr
							>{/each}</tbody
					>
				</table>
			</div>
		</details>
		<details class="rounded-md border border-border p-3">
			<summary class="cursor-pointer font-medium"
				>{t('Bundle files')} · {bundles?.asset_count ?? t('Unavailable')}</summary
			>
			<div class="mt-2 flex flex-wrap items-center gap-1" data-view-toolbar>
				<ToolbarSearch bind:value={assetSearch} label={t('Search client files')} /><ToolbarFilter
					count={assetStatus === 'all' ? 0 : 1}
					label={t('Filter client files')}
					panel_class="w-72"
					><label class="grid gap-2"
						><span class="text-label">{t('Cache residency')}</span><Combobox
							aria-label={t('Cache residency')}
							value={assetStatus}
							options={[
								{ value: 'all', label: t('All files') },
								{ value: 'cached', label: t('Cached') },
								{ value: 'cold', label: t('Not resident') }
							]}
							on_change={(status) => {
								assetStatus = status ?? 'all';
							}}
						/></label
					></ToolbarFilter
				><span class="text-meta ml-auto">{shownAssets.length} {t('files shown')}</span>
			</div>
			<div class="overflow-x-auto">
				<table class="w-full text-left">
					<thead
						><tr
							><th scope="col">{t('Client asset')}</th><th scope="col">{t('On disk')}</th><th
								scope="col">{t('Cached variants')}</th
							></tr
						></thead
					><tbody
						>{#each shownAssets as asset (asset.path)}{@const held = cacheByPath.get(asset.path)}<tr
								><th scope="row" class="max-w-md break-all font-mono font-normal">{asset.path}</th
								><td class="whitespace-nowrap font-mono">{bytes(asset.bytes)}</td><td
									class="font-mono"
									>{held?.variants.map((variant) => variant.encoding).join(', ') ||
										t('Not resident')}</td
								></tr
							>{:else}<tr
								><td colspan="3" class="text-meta">{t('No client files match these filters.')}</td
								></tr
							>{/each}</tbody
					>
				</table>
			</div>
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
				</p>{/if}<LogView
				rows={runtimeLines}
				follow={false}
				class="min-h-80 flex-1"
				filter_count={data.filters.run ? 1 : 0}
				trailing={actions}
			>
				{#snippet leading()}
					<h2 class="px-1 text-sm font-semibold">{t('Runtime & run logs')}</h2>
					<Combobox
						class="w-80"
						aria-label={t('Release')}
						searchable
						value={releaseAt ?? ''}
						options={releaseOptions}
						on_change={(at) => at !== null && (release = at || null)}
					/>
				{/snippet}
				{#snippet filters()}
					<label class="grid gap-2"
						><span class="text-label">{t('Automation run')}</span><Combobox
							aria-label={t('Automation run')}
							searchable
							value={data.filters.run}
							options={runOptions}
							on_search={(query) => {
								runSearch = query;
							}}
							on_change={(run) => run !== null && on_change({ run: run || null })}
						/></label
					>
				{/snippet}
			</LogView>
		</div>{/if}
{/snippet}
{#snippet users()}
	{#if members === null}{#if can_inspect}<p class="text-meta">
				{data.errors?.access ?? t('The named user inventory is unavailable.')}
			</p>{:else}{@render restricted()}{/if}{:else}<div class="grid gap-3">
			<div class="flex min-w-0 flex-wrap items-center gap-1" data-view-toolbar>
				<h2 class="mr-1 text-sm font-semibold">{t('Users')}</h2>
				<ToolbarSearch
					bind:value={userSearch}
					label={t('Search users by name, email or ID')}
				/><ToolbarFilter
					count={userStatus === 'all' ? 0 : 1}
					label={t('Filter users')}
					panel_class="w-72"
					><label class="grid gap-2"
						><span class="text-label">{t('Status')}</span><Combobox
							aria-label={t('User status')}
							value={userStatus}
							options={[
								{ value: 'all', label: t('All users') },
								{ value: 'recent', label: t('Recently active') },
								{ value: 'enabled', label: t('Enabled') },
								{ value: 'disabled', label: t('Disabled') },
								{ value: 'offline', label: t('Offline') },
								{ value: 'unknown', label: t('No recorded activity') }
							]}
							on_change={(status) => {
								userStatus = status ?? 'all';
							}}
						/></label
					></ToolbarFilter
				><span class="text-meta ml-auto"
					>{shownMembers.length}
					{t('of')}
					{members.length}
					{t('users')} · {members.filter((member) => member.active && online(member.last_seen))
						.length}
					{t('recently active')}</span
				>
			</div>
			<div class="overflow-x-auto rounded-md border border-border px-3">
				<table class="w-full text-left">
					<thead
						><tr
							><th scope="col">{t('User')}</th><th scope="col">{t('Email / login identity')}</th><th
								scope="col">{t('Status')}</th
							><th scope="col">{t('Last authenticated activity')}</th></tr
						></thead
					><tbody
						>{#each shownMembers as member (member.id)}<tr
								><th scope="row" class="font-medium"
									>{member.name}
									<div class="text-meta font-mono">{member.id}</div></th
								><td>{member.email ?? t('Not recorded')}</td><td
									><span
										class={`inline-flex rounded px-2 py-0.5 text-micro ${!member.active ? 'bg-muted text-muted-foreground' : 'text-foreground'}`}
										>{t(
											!member.active
												? 'Disabled'
												: online(member.last_seen)
													? 'Recently active'
													: member.last_seen === null
														? 'Unknown'
														: 'Offline'
										)}</span
									></td
								><td class="whitespace-nowrap">{when(member.last_seen)}</td></tr
							>{:else}<tr
								><td colspan="4" class="text-meta"
									>{t(members.length === 0 ? 'No users.' : 'No users match these filters.')}</td
								></tr
							>{/each}</tbody
					>
				</table>
			</div>
		</div>{/if}
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
