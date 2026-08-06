<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Inline } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	const { t } = useI18n<TenantI18nKeys>();

	type ReclamationProjectScopeRow = {
		readonly norbital_id: string;
		readonly project_name: string;
		readonly project_code?: string | null;
		readonly status?: string | null;
	};

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
	<meta
		name="pod:thumbnail"
		content="/api/template-seed-assets/reclamation/app-media/reclamation_projects-banner.svg"
	/>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/reclamation/app-media/reclamation_projects-banner.svg"
	/>
</svelte:head>

{#snippet projectScopeActions()}
	<label class="grid gap-1.5 text-sm">
		<span class="font-medium text-muted-foreground"
			>{t('app.reclamation_projects.project_filter')}</span
		>
		<Inline gap="sm">
			<Combobox
				ariaLabel={t('app.reclamation_projects.project_filter')}
				options={projectOptions}
				value={selectedProjectId}
				onValueChange={(value) => {
					if (typeof value === 'string') {
						projectId = value;
						return;
					}
					projectId = resolveScopedId(null, projectRows);
				}}
				emptyPlaceholder={t('app.reclamation_projects.select_project')}
				searchPlaceholder={t('app.reclamation_projects.search_projects')}
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
		title={t('app.reclamation_projects.tab_projects')}
		description={t('app.reclamation_projects.projects_description')}
	>
		{#snippet columns({ Column })}
			<Column name="project_name" minWidth={220} />
			<Column name="project_code" label={t('component.code')} />
			<Column name="client" />
			<Column name="status" />
			<Column name="datum" />
			<Column name="interpolation" label={t('app.reclamation_projects.between_sections')} />
		{/snippet}
		{#snippet ListCard(project)}
			<Inline align="start" justify="between" gap="sm">
				<p class="truncate font-medium">{project.project_name}</p>
				<span class="shrink-0 text-xs text-muted-foreground">
					{project.status ?? t('component.no_status')}
				</span>
			</Inline>
			<p class="mt-1 truncate text-sm text-muted-foreground">
				{project.project_code ?? t('component.no_code')} · {project.client ??
					t('component.no_client')}
			</p>
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet reconstructions()}
	{#if selectedProjectId == null}
		<p class="text-sm text-muted-foreground">
			{t('app.reclamation_projects.empty_reconstructions')}
		</p>
	{:else}
		<CollectionTable
			{client}
			collection="site_reconstructions"
			title={t('app.reclamation_projects.reconstruction_revisions')}
			description={t('app.reclamation_projects.reconstruction_revisions_description')}
			view={`reclamation_projects:reconstructions:${selectedProjectId}`}
			query={{
				where: { project_id: { eq: selectedProjectId } },
				orderBy: { revision: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="revision" />
				<Column name="status" />
				<Column name="stitched_at" label={t('app.reclamation_projects.stitched')} />
				<Column name="platform_area_m2" label={t('app.reclamation_projects.platform_m2')} />
				<Column name="placed_volume_m3" label={t('app.reclamation_projects.placed_m3')} />
				<Column name="mean_fill_depth_m" label={t('app.reclamation_projects.mean_depth_m')} />
				<Column name="excavation_m3" label={t('app.reclamation_projects.excavated_m3')} />
				<Column name="warning_count" label={t('app.reclamation_projects.flagged')} />
				<Column name="assumption_count" label={t('app.reclamation_projects.assumed')} />
			{/snippet}
			{#snippet ListCard(run)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">
						{t('app.reclamation_projects.revision_n', { revision: run.revision })}
					</p>
					<span class="shrink-0 text-xs text-muted-foreground">{run.status}</span>
				</Inline>
				<p class="mt-1 truncate text-sm text-muted-foreground">
					{t('app.reclamation_projects.flagged_assumed', {
						flagged: run.warning_count ?? 0,
						assumed: run.assumption_count ?? 0
					})}
				</p>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.reclamation_projects.eyebrow')}
		title={t('app.reclamation_projects.header_title')}
		description={t('app.reclamation_projects.header_description')}
		actions={projectScopeActions}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		lazyLoad={false}
		animate={false}
		config={[
			{
				name: 'projects',
				label: t('app.reclamation_projects.tab_projects'),
				icon: 'lucide:waves',
				content: projects
			},
			{
				name: 'reconstructions',
				label: t('app.reclamation_projects.tab_reconstructions'),
				icon: 'lucide:box',
				content: reconstructions
			}
		] satisfies TabConfig[]}
	/>
</Cover>
