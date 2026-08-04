<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Inline } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	type ReclamationProjectScopeRow = {
		readonly norbital_id: string;
		readonly project_name: string;
		readonly project_code?: string | null;
		readonly status?: string | null;
	};

	const IN_FLIGHT_STATUSES = ['planning', 'design', 'tender', 'construction'] as const;

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
	const projectRows = $derived(
		(projectsQuery.current ?? []) as readonly ReclamationProjectScopeRow[]
	);
	const projectOptions = $derived(
		projectRows.map((project) => ({
			value: project.norbital_id,
			label: projectLabel(project),
			search_term: `${project.project_code ?? ''} ${project.project_name ?? ''}`
		}))
	);
	const selectedProjectId = $derived(resolveScopedId(projectId, projectRows));
</script>

<svelte:head>
	<title>Reclamation Projects</title>
	<meta name="description" content="Reclamation projects and their stitched reconstructions." />
	<meta name="pod:icon" content="lucide:waves" />
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
					projectId = resolveScopedId(null, projectRows);
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

{#snippet projects()}
	<CollectionTable
		{client}
		collection="reclamation_projects"
		title="Projects"
		description="Open a project to see its documents beside the reconstructed site."
	>
		{#snippet columns({ Column })}
			<Column name="project_name" minWidth={220} />
			<Column name="project_code" label="Code" />
			<Column name="client" />
			<Column name="status" />
			<Column name="datum" />
			<Column name="interpolation" label="Between sections" />
		{/snippet}
		{#snippet ListCard(project)}
			<Inline align="start" justify="between" gap="sm">
				<p class="truncate font-medium">{project.project_name}</p>
				<span class="shrink-0 text-xs text-muted-foreground">{project.status ?? 'no status'}</span>
			</Inline>
			<p class="mt-1 truncate text-sm text-muted-foreground">
				{project.project_code ?? 'no code'} · {project.client ?? 'no client'}
			</p>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet reconstructions()}
	{#if selectedProjectId == null}
		<p class="text-sm text-muted-foreground">Select a project to browse its reconstructions.</p>
	{:else}
		<CollectionTable
			{client}
			collection="site_reconstructions"
			title="Reconstruction revisions"
			description="Every stitch run, newest first. A revision is never overwritten, so an estimate always points at the geometry it was priced against."
			view={`reclamation_projects:reconstructions:${selectedProjectId}`}
			query={{
				where: { project_id: { eq: selectedProjectId } },
				orderBy: { revision: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="revision" />
				<Column name="status" />
				<Column name="stitched_at" label="Stitched" />
				<Column name="platform_area_m2" label="Platform m²" />
				<Column name="placed_volume_m3" label="Placed m³" />
				<Column name="mean_fill_depth_m" label="Mean depth m" />
				<Column name="excavation_m3" label="Excavated m³" />
				<Column name="warning_count" label="Flagged" />
				<Column name="assumption_count" label="Assumed" />
			{/snippet}
			{#snippet ListCard(run)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">Revision {run.revision}</p>
					<span class="shrink-0 text-xs text-muted-foreground">{run.status}</span>
				</Inline>
				<p class="mt-1 truncate text-sm text-muted-foreground">
					{run.warning_count ?? 0} flagged · {run.assumption_count ?? 0} assumed
				</p>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Reclamation"
		title="Projects"
		description="Three documents per project become one 3D site solid, and that solid becomes the take-off."
		actions={projectScopeActions}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		lazyLoad={false}
		animate={false}
		config={[
			{ name: 'projects', label: 'Projects', icon: 'lucide:waves', content: projects },
			{
				name: 'reconstructions',
				label: 'Reconstructions',
				icon: 'lucide:box',
				content: reconstructions
			}
		] satisfies TabConfig[]}
	/>
</Cover>
