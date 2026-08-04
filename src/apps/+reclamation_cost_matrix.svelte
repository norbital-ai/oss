<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { SUBSTRATES, substrateDefinition } from '../lib/reclamation/cost.js';
	import { calendarDateInTimeZone, PROJECT_TIME_ZONE } from '../lib/calendar.js';
	import type { SubstrateId } from '../lib/reclamation/types.js';

	type ReclamationProjectScopeRow = {
		readonly norbital_id: string;
		readonly project_name: string;
		readonly project_code?: string | null;
		readonly status?: string | null;
	};

	// The site's calendar day, so "the rates in force today" means the same day here, in the project
	// cost panel, and in the server hook that prices an estimate against `contains_date`.
	const today = calendarDateInTimeZone(new Date(), PROJECT_TIME_ZONE);
	const activeRates = { validity_range: { contains_date: today } } as const;

	const IN_FLIGHT_STATUSES = ['planning', 'design', 'tender', 'construction'] as const;

	// stupidity:allow D1 -- an entity-scope selector is inlined per app on purpose; controller-surfaces.md §1.
	function resolveScopedId(
		selected: string | null,
		rows: readonly ReclamationProjectScopeRow[]
	): string | null {
		if (selected != null && rows.some((row) => row.norbital_id === selected)) return selected;
		const active = rows.find((row) =>
			IN_FLIGHT_STATUSES.includes((row.status ?? '') as (typeof IN_FLIGHT_STATUSES)[number])
		);
		return active?.norbital_id ?? rows[0]?.norbital_id ?? null;
	}

	// stupidity:allow D1 -- a human label belongs at the surface that paints it; controller-surfaces.md §1.
	function projectLabel(record: ReclamationProjectScopeRow): string {
		const code = record.project_code;
		const name = record.project_name;
		if (code && name) return `${code} · ${name}`;
		return name || '—';
	}

	let projectId = $state<string | null>(null);
	const projectsQuery = client.db.reclamation_projects.findMany({
		orderBy: { project_code: 'asc' },
		limit: 200
	});
	const projects = $derived((projectsQuery.current ?? []) as readonly ReclamationProjectScopeRow[]);
	const projectOptions = $derived(
		projects.map((project) => ({
			value: project.norbital_id,
			label: projectLabel(project),
			search_term: `${project.project_code ?? ''} ${project.project_name ?? ''}`
		}))
	);
	const selectedProjectId = $derived(resolveScopedId(projectId, projects));

	const reconstructionsQuery = $derived(
		selectedProjectId == null
			? null
			: client.db.site_reconstructions.findMany({
					where: { project_id: { eq: selectedProjectId } },
					columns: { norbital_id: true, revision: true },
					orderBy: { revision: 'desc' },
					limit: 200
				})
	);
	const reconstructionLabelsById = $derived(
		new Map(
			(reconstructionsQuery?.current ?? []).map((run) => [
				run.norbital_id,
				`Revision ${run.revision}`
			])
		)
	);
</script>

<svelte:head>
	<title>Reclamation Cost Matrix</title>
	<meta name="description" content="Unit rates per substrate and the estimates built from them." />
	<meta name="pod:icon" content="lucide:table-2" />
</svelte:head>

{#snippet projectScopeActions()}
	<label class="grid gap-1.5 text-sm">
		<span class="font-medium text-muted-foreground">Project</span>
		<Inline gap="sm">
			<Combobox
				ariaLabel="Project"
				options={projectOptions}
				value={selectedProjectId}
				onValueChange={(value) => {
					if (typeof value === 'string') {
						projectId = value;
						return;
					}
					projectId = resolveScopedId(null, projects);
				}}
				emptyPlaceholder="Select project…"
				searchPlaceholder="Search projects…"
				clientConfig={{
					isLoading: projectsQuery.loading,
					error: projectsQuery.error?.message ?? null
				}}
				class="min-w-[16rem]"
			/>
		</Inline>
	</label>
{/snippet}

{#snippet rates()}
	<CollectionTable
		{client}
		collection="cost_rates"
		title="Unit cost matrix"
		description="One rate per substrate, shared by every project. Rates never change a volume."
		query={{ where: activeRates }}
	>
		{#snippet columns({ Column })}
			<Column name="label" minWidth={200} />
			<Column
				name="substrate"
				render={({ value }) =>
					value != null && value !== '' ? substrateDefinition(value as SubstrateId).label : '—'}
			/>
			<Column name="unit" />
			<Column name="rate" />
			<Column name="rate_basis" label="Basis" />
			<Column name="source" />
			<Column name="validity_range" label="Valid" />
		{/snippet}
		{#snippet ListCard(rate)}
			<Inline align="start" justify="between" gap="sm">
				<p class="truncate font-medium">{rate.label}</p>
				<span class="shrink-0 text-xs text-muted-foreground">{rate.unit}</span>
			</Inline>
			<p class="mt-1 truncate text-sm text-muted-foreground">
				{rate.substrate != null && rate.substrate !== ''
					? substrateDefinition(rate.substrate as SubstrateId).label
					: '—'} · {rate.rate_basis ?? 'basis not stated'}
			</p>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet estimates()}
	{#if selectedProjectId == null}
		<p class="text-sm text-muted-foreground">Select a project to browse its estimates.</p>
	{:else}
		<CollectionTable
			{client}
			collection="cost_estimates"
			title="Estimates"
			description="Each estimate prices one reconstruction revision. Totals recompute on every save."
			view={`reclamation_cost_matrix:estimates:${selectedProjectId}`}
			query={{
				where: { project_id: { eq: selectedProjectId } },
				orderBy: { priced_at: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="estimate_name" minWidth={200} />
				<Column
					name="reconstruction_id"
					label="Reconstruction"
					minWidth={160}
					render={({ value }) =>
						value == null || value === ''
							? '—'
							: (reconstructionLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="status" />
				<Column name="currency" />
				<Column name="subtotal" />
				<Column name="contingency" />
				<Column name="total" />
				<Column name="priced_at" label="Priced" />
			{/snippet}
			{#snippet ListCard(estimate)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">{estimate.estimate_name}</p>
					<span class="shrink-0 text-xs text-muted-foreground">{estimate.status ?? 'draft'}</span>
				</Inline>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet catalogue()}
	<Stack gap="md">
		<div class="divide-y rounded-md border bg-card text-sm">
			{#each SUBSTRATES as substrate (substrate.id)}
				<div class="p-3">
					<Inline align="start" justify="between" gap="sm">
						<p class="min-w-0 truncate font-medium">{substrate.label}</p>
						<span class="shrink-0 text-xs text-muted-foreground">
							{substrate.unit === 'm3' ? 'm³' : substrate.unit === 'm2' ? 'm²' : 'm'} · {substrate.driver}
						</span>
					</Inline>
					<p class="mt-1 text-xs text-muted-foreground">{substrate.note}</p>
				</div>
			{/each}
		</div>
		<p class="max-w-[70ch] text-xs text-muted-foreground">
			The catalogue is fixed by the engine: a substrate exists because the solid can measure it. A
			rate row without a matching substrate is never priced, and a substrate without a rate row
			prices at zero and is listed on the estimate as a missing rate.
		</p>
	</Stack>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Reclamation settings"
		title="Cost Matrix"
		description="Unit rates per substrate, the estimates built from them, and what each substrate measures."
		actions={projectScopeActions}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		lazyLoad={false}
		animate={false}
		config={[
			{ name: 'rates', label: 'Unit rates', icon: 'lucide:table-2', content: rates },
			{ name: 'estimates', label: 'Estimates', icon: 'lucide:calculator', content: estimates },
			{ name: 'catalogue', label: 'Substrate catalogue', icon: 'lucide:layers', content: catalogue }
		] satisfies TabConfig[]}
	/>
</Cover>
