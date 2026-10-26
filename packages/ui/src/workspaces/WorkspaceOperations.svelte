<script lang="ts" module>
	import type { Effect as EffectType } from 'effect';
	import type {
		WorkspaceOperationsData,
		WorkspaceOperation,
		WorkspaceScope,
		WorkspaceRange,
		WorkspaceView
	} from './types.js';
	export type WorkspaceOperationsProps = {
		data: WorkspaceOperationsData;
		range: WorkspaceRange;
		view: WorkspaceView;
		busy?: boolean;
		/** Stable workspace identity: a pending confirmation cannot cross a scope change. */
		scopeKey?: string;
		onChange: (next: WorkspaceScope) => void;
		onOperate?: (operation: WorkspaceOperation) => EffectType.Effect<unknown, Error>;
		t?: (key: string) => string;
	};
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import { onDestroy } from 'svelte';
	import { fork } from '../effect/index.js';
	import Button from '../primitives/button/button.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import Tabs from '../primitives/tabs/tabs.svelte';
	import ToolbarSearch from '../collection/toolbar/ToolbarSearch.svelte';
	import ToolbarFilter from '../collection/toolbar/ToolbarFilter.svelte';
	import LogView from '../logs/LogView.svelte';
	import UsageChart, { formatMetricValue } from '../chart/UsageChart.svelte';
	import ReleaseTimeline from '../releases/ReleaseTimeline.svelte';
	import { rollbackReason } from '../releases/model.js';
	import { confirmAction, type ConfirmOptions } from '../primitives/dialog/confirm.js';
	import { filterMembers, filterBuilds } from './filters.js';
	import type { WorkspaceChange } from './types.js';
	let {
		data,
		range,
		view,
		busy = false,
		scopeKey = '',
		onChange,
		onOperate,
		t = (key) => key
	}: WorkspaceOperationsProps = $props();
	let userSearch = $state(''),
		userStatus = $state('all'),
		buildSearch = $state(''),
		buildStatus = $state('all');
	let assetSearch = $state(''),
		assetStatus = $state('all'),
		runSearch = $state(''),
		packageSearch = $state('');
	let selectedChange = $state<string | null>(null);
	let acting = $state(false),
		notice = $state('');
	let disposed = false;
	onDestroy(() => {
		disposed = true;
	});
	const locked = $derived(busy || acting);
	const canInspect = $derived(data.canInspect);
	const studio = $derived(data.studio),
		members = $derived(data.members),
		bundles = $derived(data.bundles),
		cache = $derived(data.cache);
	const shownMembers = $derived(filterMembers(members ?? [], userSearch, userStatus, data.asOf));
	const shownBuilds = $derived(filterBuilds(studio?.builds ?? [], buildSearch, buildStatus));
	const change = $derived(
		studio?.changes.find((item) => item.id === selectedChange) ??
			studio?.changes.find((item) => item.head === studio.build?.build.commit) ??
			studio?.changes.find((item) => item.state === 'open') ??
			studio?.changes[0] ??
			null
	);
	const query = $derived(buildSearch.trim().toLowerCase());
	const shownReleases = $derived(
		(studio?.releases ?? []).filter(
			(release) =>
				`${release.commit} ${release.at} ${release.message}`.toLowerCase().includes(query) &&
				(buildStatus === 'all' ||
					(buildStatus === 'live' && release.current) ||
					(buildStatus === 'built' && shownBuilds.some((build) => build.commit === release.commit)))
		)
	);
	const shownChanges = $derived(
		(studio?.changes ?? []).filter(
			(change) =>
				`${change.id} ${change.title} ${change.head}`.toLowerCase().includes(query) &&
				(buildStatus === 'all' || shownBuilds.some((build) => build.commit === change.head))
		)
	);
	const cacheByPath = $derived(new Map((cache?.assets ?? []).map((asset) => [asset.path, asset])));
	const shownAssets = $derived(
		(bundles?.assets ?? []).filter(
			(asset) =>
				`${asset.path} ${asset.sha256}`.toLowerCase().includes(assetSearch.trim().toLowerCase()) &&
				(assetStatus === 'all' ||
					(cache !== null &&
						(assetStatus === 'cached'
							? (cacheByPath.get(asset.path)?.cachedBytes ?? 0) > 0
							: (cacheByPath.get(asset.path)?.cachedBytes ?? 0) === 0)))
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
	const runtimeLines = $derived(
		[...(data.logs ?? [])].reverse().map((row) => ({
			id: row.id,
			at: row.at,
			level: row.severity,
			message: `${row.event} ${JSON.stringify(row.attributes)}`,
			...(row.run === null ? {} : { source: `run ${row.run}` })
		}))
	);
	const buildLines = $derived(
		(studio?.build?.log ?? []).map((row, index) => ({
			id: `${index}:${row.at}`,
			at: row.at,
			level: row.level,
			message: row.message
		}))
	);
	const when = (value: string | null) =>
		value === null ? t('Not recorded') : new Date(value).toLocaleString();
	const online = (value: string | null) =>
		value !== null && Date.parse(value) > Date.parse(data.asOf) - 300000;
	const bytes = (value: number | null) => formatMetricValue('bytes', value);
	function perform(operation: WorkspaceOperation, ask?: ConfirmOptions) {
		if (locked || !canInspect || onOperate === undefined) return;
		const run = onOperate;
		const ownScope = scopeKey;
		acting = true;
		notice = '';
		fork(
			Effect.gen(function* () {
				if (ask !== undefined && !(yield* confirmAction(ask))) return;
				if (disposed || ownScope !== scopeKey) return;
				yield* run(operation);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						acting = false;
					})
				)
			),
			(error) => {
				notice = error.message;
			}
		);
	}
	function restore(commit: string) {
		const target = studio?.releases.find((release) => release.commit === commit);
		if (target === undefined || rollbackReason(target) !== null) return;
		const lost = target.discards;
		perform(
			{ op: 'rollback', commit, ...(lost === undefined ? {} : { discardDataSince: lost }) },
			{
				title: t(target.undo ? 'Undo the rollback?' : 'Roll back live to this version?'),
				body: `${when(target.checkpoint ?? target.at)} — ${target.message || commit.slice(0, 8)}. ${lost === undefined ? t('Its source comes back and live keeps all its data.') : `${t('Its schema differs from live’s, so the data written after')} ${when(lost)} ${t('will be lost.')}`} ${t('Live as it is now is kept, so this can be undone. Everyone stays signed in.')}`,
				confirmLabel: t(target.undo ? 'Undo' : 'Roll back'),
				cancelLabel: t('Cancel'),
				destructive: lost !== undefined
			}
		);
	}
	function merge(change: WorkspaceChange) {
		if (
			change.preview === null ||
			change.preview.url === null ||
			change.preview.stale ||
			change.preview.shelved
		)
			return;
		const accept = change.preview.destructive ?? [];
		perform(
			{ op: 'change.merge', id: change.id, ...(accept.length === 0 ? {} : { accept }) },
			{
				title: `${t('Merge')} !${change.id} ${t('into live?')}`,
				body: `${change.title}. ${accept.length > 0 ? `${t('This applies destructive schema steps:')} ${accept.join(', ')}. ` : ''}${t('It merges with live, builds and checks the result, then everyone using the workspace gets it.')}`,
				confirmLabel: t('Merge'),
				cancelLabel: t('Cancel'),
				destructive: accept.length > 0
			}
		);
	}
	function close(change: WorkspaceChange) {
		perform(
			{ op: 'change.close', id: change.id },
			{
				title: t('Close this change?'),
				body: `${change.title}. ${t('Its preview environment and preview data are removed. Saved builds remain subject to retention.')}`,
				confirmLabel: t('Close change'),
				cancelLabel: t('Cancel'),
				destructive: true
			}
		);
	}
</script>

<div class="grid min-w-0 gap-3 text-xs" aria-busy={locked} data-workspace-operations>
	{#if notice}<p role="alert" class="text-destructive">{notice}</p>{/if}
	<Tabs
		value={view}
		class="gap-3"
		onValueChange={(next) =>
			onChange({
				view: next === 'resources' || next === 'logs' || next === 'users' ? next : 'activity'
			})}
		tabs={[
			{ name: 'activity', title: t('Activity'), icon: 'lucide:history', body: activity },
			{ name: 'resources', title: t('Resources'), icon: 'lucide:activity', body: resources },
			{ name: 'logs', title: t('Runtime & runs'), icon: 'lucide:scroll-text', body: runtime },
			{ name: 'users', title: t('Users'), icon: 'lucide:users', body: users }
		]}
	/>
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
{#snippet resources()}
	<div class="grid gap-3">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 class="text-sm font-semibold">{t('Resource use')}</h2>
			<nav aria-label={t('Trend range')} class="flex gap-1">
				{#each ['24h', '7d', '30d'] as item (item)}<Button
						size="sm"
						variant={range === item ? 'secondary' : 'ghost'}
						class="h-8 px-2.5 text-xs"
						onclick={() => onChange({ range: item === '24h' || item === '30d' ? item : '7d' })}
						>{item}</Button
					>{/each}
			</nav>
		</div>
		<p class="text-meta">
			{t(
				'Interval peaks for sampled resources; totals for compute and AI. Storage carries the latest successful reading.'
			)}
		</p>
		<div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
			{#each data.usage as chart (chart.title)}<UsageChart {...chart} />{/each}
		</div>
	</div>
{/snippet}
{#snippet activity()}
	{#if !canInspect}{@render restricted()}{:else}
		<div class="grid min-w-0 gap-5">
			<div class="flex min-w-0 flex-wrap items-center gap-1" data-view-toolbar>
				<h2 class="mr-1 text-sm font-semibold">{t('Build and release activity')}</h2>
				<ToolbarSearch
					bind:value={buildSearch}
					label={t('Search commits, changes and builds')}
				/><ToolbarFilter
					count={buildStatus === 'all' ? 0 : 1}
					label={t('Filter activity')}
					panelClass="w-72"
					><label class="grid gap-2"
						><span class="text-label">{t('Status')}</span><Combobox
							size="sm"
							aria-label={t('Activity status')}
							value={buildStatus}
							options={[
								{ value: 'all', label: t('All activity') },
								{ value: 'live', label: t('Live') },
								{ value: 'built', label: t('Built') },
								{ value: 'failed', label: t('Failed') }
							]}
							onChange={(status) => {
								buildStatus = status ?? 'all';
							}}
						/></label
					></ToolbarFilter
				>
			</div>
			{#if data.errors?.studio}<p role="alert" class="text-destructive">
					{data.errors.studio}
				</p>{/if}
			<div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
				<section class="min-w-0" aria-label={t('Commit timeline')}>
					<ReleaseTimeline
						builds={shownBuilds}
						releases={shownReleases}
						changes={shownChanges}
						environments={studio?.environments ?? []}
						selected={studio?.build?.build.commit ?? data.filters.build}
						onSelect={(commit) => onChange({ build: commit })}
						onBuild={(commit) => onChange({ build: commit })}
						onRestore={onOperate === undefined ? undefined : restore}
						busy={locked}
						{t}
					/>
				</section>
				<div class="grid min-w-0 content-start gap-4">
					{#if studio?.build}
						<section class="grid min-w-0 gap-3" aria-label={t('Selected build')}>
							<div class="flex flex-wrap items-start justify-between gap-3">
								<div class="grid min-w-0 gap-1">
									<h3 class="text-sm font-semibold">
										{studio.build.build.message || t('Build output')}
									</h3>
									<p class="text-meta">
										<code>{studio.build.build.commit.slice(0, 12)}</code> · {when(
											studio.build.build.at
										)} · {studio.build.build.lines}
										{t('log lines')} · {studio.build.build.diagnostics}
										{t('diagnostics')}
									</p>
								</div>
								<span class="rounded bg-muted px-2 py-1 text-micro"
									>{t(
										studio.build.build.live
											? 'Serving live'
											: studio.build.build.status === 'failed'
												? 'Failed'
												: 'Built'
									)}</span
								>
							</div>
							<LogView
								rows={buildLines}
								follow={false}
								class="h-80"
							/>{#if studio.build.diagnostics.length > 0}<details
									class="rounded-md border border-border p-3"
								>
									<summary class="cursor-pointer font-medium">{t('Build diagnostics')}</summary>
									<ul class="mt-2 grid gap-2 font-mono text-xs">
										{#each studio.build.diagnostics as diagnostic, index (index)}<li
												class="break-words"
											>
												{JSON.stringify(diagnostic)}
											</li>{/each}
									</ul>
								</details>{/if}
						</section>
					{:else}<p class="text-meta">
							{data.errors?.build ?? t('Select a retained build to inspect its output.')}
						</p>{/if}
					{#if (studio?.changes.length ?? 0) > 0}
						<section class="grid gap-2" aria-label={t('Change controls')}>
							<div class="flex flex-wrap items-center justify-between gap-2">
								<h3 class="font-medium">{t('Change and preview')}</h3>
								<Combobox
									class="w-64"
									size="sm"
									aria-label={t('Change scope')}
									searchable
									value={change?.id ?? null}
									options={(studio?.changes ?? []).map((item) => ({
										value: item.id,
										label: `!${item.id} · ${item.title}`,
										description: t(item.state)
									}))}
									onChange={(id) => {
										selectedChange = id;
									}}
								/>
							</div>
							{#if change}
								<div class="grid gap-2 rounded-md border border-border p-3">
									<div class="flex flex-wrap items-center justify-between gap-2">
										<span class="font-medium">{change.title}</span><span class="text-meta"
											>{t(change.merge?.state === 'running' ? 'Merging' : change.state)}</span
										>
									</div>
									<p class="text-meta">
										<code>{change.head.slice(0, 12)}</code> · {when(
											change.updatedAt
										)}{#if (change.behind ?? 0) > 0}
											· {change.behind} {t('behind live')}{/if}
									</p>
									{#if change.merge?.error}<p class="text-destructive">{change.merge.error}</p>{/if}
									{#if change.state === 'open'}
										<div class="flex flex-wrap gap-1.5">
											{#if change.preview?.url}<Button
													size="sm"
													variant="outline"
													class="text-xs"
													href={change.preview.url}>{t('Open preview')}</Button
												>{/if}
											{#if onOperate}
												<Button
													size="sm"
													variant="outline"
													class="text-xs"
													disabled={locked || change.merge?.state === 'running'}
													disabledMessage={t('A workflow operation is already running.')}
													onclick={() => perform({ op: 'change.open', id: change.id })}
													>{t(change.preview?.shelved ? 'Resume preview' : 'Select change')}</Button
												>
												<Button
													size="sm"
													variant="outline"
													class="text-xs"
													disabled={locked || change.merge?.state === 'running'}
													disabledMessage={t('A workflow operation is already running.')}
													onclick={() => perform({ op: 'preview', id: change.id })}
													>{t('Build preview')}</Button
												>
												<Button
													size="sm"
													variant="outline"
													class="text-xs"
													disabled={locked ||
														change.merge?.state === 'running' ||
														change.preview === null ||
														change.preview.url === null ||
														change.preview.stale ||
														change.preview.shelved === true}
													disabledMessage={t(
														'Build and route a preview of the latest commit before merging.'
													)}
													onclick={() => merge(change)}>{t('Merge')}</Button
												>
												<Button
													size="sm"
													variant="ghost"
													class="text-xs"
													disabled={locked || change.merge?.state === 'running'}
													disabledMessage={t('A running merge cannot be closed.')}
													onclick={() => close(change)}>{t('Close')}</Button
												>
											{/if}
										</div>
									{:else}<p class="text-meta">
											{t(
												'This change is complete. Preview cleanup is reported below; retained builds follow retention rules.'
											)}
										</p>{/if}
								</div>
							{/if}
						</section>
					{/if}
					{@render artifactDetails()}
				</div>
			</div>
		</div>
	{/if}
{/snippet}
{#snippet artifactDetails()}
	<section class="grid min-w-0 gap-3" aria-labelledby="workspace-bundle-health">
		<h3 id="workspace-bundle-health" class="text-sm font-semibold">
			{t('Artifact and cleanup')}
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
		<dl class="grid gap-4 border-b border-border pb-3 sm:grid-cols-2">
			<div>
				<dt class="text-meta">{t(bundles?.live ? 'Live artifact' : 'Selected build artifact')}</dt>
				<dd class="mt-1 truncate font-mono" title={bundles?.digest}>
					{bundles?.digest.slice(0, 16) ?? t('Unavailable')}
				</dd>
			</div>
			<div>
				<dt class="text-meta">{t('Artifact bytes')}</dt>
				<dd class="mt-1 font-medium tabular-nums">{bytes(data.health?.artifactBytes ?? null)}</dd>
			</div>
			<div>
				<dt class="text-meta">{t('Public client bytes')}</dt>
				<dd class="mt-1 font-medium tabular-nums">{bytes(bundles?.totalBytes ?? null)}</dd>
			</div>
			<div>
				<dt class="text-meta">{t('Referenced cache bytes')}</dt>
				<dd class="mt-1 font-medium tabular-nums">
					{bundles?.assetCount === null ? t('Unavailable') : bytes(cache?.releaseBytes ?? null)}
				</dd>
			</div>
		</dl>
		{#each data.health?.errors ?? [] as error, index (index)}<p class="text-meta">{error}</p>{/each}
		{#if cache}<p class="text-meta">
				{t('Shared host cache')}:
				<span class="font-mono">{bytes(cache.hostBytes)} / {bytes(cache.budgetBytes)}</span>
				· {cache.releaseEntries}
				{t('entries referenced by this release')}
			</p>{/if}
		{#if data.errors?.cache}<p role="alert" class="text-destructive">{data.errors.cache}</p>{/if}
		<p class="text-meta">
			{t(
				'An artifact retained for a live release, restore point or recent build is expected. A leftover preview environment after merge or close needs attention.'
			)}
		</p>
		{#if (data.health?.cleanup.length ?? 0) > 0}<div class="overflow-x-auto">
				<table class="w-full text-left">
					<caption class="sr-only">{t('Preview cleanup status')}</caption><thead
						><tr
							><th scope="col">{t('Change')}</th><th scope="col">{t('Preview')}</th><th scope="col"
								>{t('Cleanup')}</th
							></tr
						></thead
					><tbody
						>{#each data.health?.cleanup ?? [] as item (item.changeId)}<tr
								><th scope="row" class="font-medium">{item.title}</th><td class="font-mono"
									>{item.environment}</td
								><td
									><span
										class={item.status === 'leftover'
											? 'font-medium text-destructive'
											: 'text-foreground'}>{t(item.status)}</span
									>
									<p class="text-meta mt-1">{item.reason}</p></td
								></tr
							>{/each}</tbody
					>
				</table>
			</div>{/if}
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
				>{t('Bundle files')} · {bundles?.assetCount ?? t('Unavailable')}</summary
			>
			<div class="mt-2 flex flex-wrap items-center gap-1" data-view-toolbar>
				<ToolbarSearch bind:value={assetSearch} label={t('Search client files')} /><ToolbarFilter
					count={assetStatus === 'all' ? 0 : 1}
					label={t('Filter client files')}
					panelClass="w-72"
					><label class="grid gap-2"
						><span class="text-label">{t('Cache residency')}</span><Combobox
							size="sm"
							aria-label={t('Cache residency')}
							value={assetStatus}
							options={[
								{ value: 'all', label: t('All files') },
								{ value: 'cached', label: t('Cached') },
								{ value: 'cold', label: t('Not resident') }
							]}
							onChange={(status) => {
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
		<details class="text-meta">
			<summary class="w-fit cursor-pointer underline decoration-border underline-offset-4"
				>{t('How retention and cache are counted')}</summary
			>
			<p class="mt-2 max-w-prose">
				{t(
					'Each environment selects one immutable artifact. Closing or merging removes the preview environment, while artifact cleanup follows references and retention. Content-addressed cache buffers may be shared by multiple tenants. Artifact bytes are logical size, not exclusive physical disk usage.'
				)}
			</p>
		</details>
	</section>
{/snippet}
{#snippet runtime()}
	{#if !canInspect}{@render restricted()}{:else}<div class="grid gap-3">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 class="text-sm font-semibold">{t('Runtime & run logs')}</h2>
					<p class="text-meta mt-1">{t('Live environment · newest 200 records')}</p>
				</div>
				<Combobox
					size="sm"
					class="w-64"
					aria-label={t('Automation run')}
					searchable
					value={data.filters.run}
					options={runOptions}
					onSearch={(query) => {
						runSearch = query;
					}}
					onChange={(run) => run !== null && onChange({ run: run || null })}
				/>
			</div>
			{#if data.errors?.logs}<p role="alert" class="text-destructive">
					{data.errors.logs}
				</p>{/if}<LogView rows={runtimeLines} follow={false} class="h-[32rem]" />
			<p class="text-meta">
				{t(
					'Select a recent run or search for its exact ID. Search and level filters use the shared toolbar; Refresh reads a new snapshot.'
				)}
			</p>
		</div>{/if}
{/snippet}
{#snippet users()}
	{#if members === null}{#if canInspect}<p class="text-meta">
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
					panelClass="w-72"
					><label class="grid gap-2"
						><span class="text-label">{t('Status')}</span><Combobox
							size="sm"
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
							onChange={(status) => {
								userStatus = status ?? 'all';
							}}
						/></label
					></ToolbarFilter
				><span class="text-meta ml-auto"
					>{shownMembers.length}
					{t('of')}
					{members.length}
					{t('users')} · {members.filter((member) => member.active && online(member.lastSeen))
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
												: online(member.lastSeen)
													? 'Recently active'
													: member.lastSeen === null
														? 'Unknown'
														: 'Offline'
										)}</span
									></td
								><td class="whitespace-nowrap">{when(member.lastSeen)}</td></tr
							>{:else}<tr
								><td colspan="4" class="text-meta"
									>{t(members.length === 0 ? 'No users.' : 'No users match these filters.')}</td
								></tr
							>{/each}</tbody
					>
				</table>
			</div>
			<p class="text-meta">
				{t(
					'Last activity is the latest successful authenticated workspace request. It does not establish a login time or an open session.'
				)}
			</p>
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
