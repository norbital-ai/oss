<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover, Inline } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
</script>

<svelte:head>
	<title>Reclamation Projects</title>
	<meta name="description" content="Reclamation projects and their stitched reconstructions." />
	<meta name="pod:icon" content="lucide:waves" />
</svelte:head>

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
	<CollectionTable
		{client}
		collection="site_reconstructions"
		title="Reconstruction revisions"
		description="Every stitch run, newest first. A revision is never overwritten, so an estimate always points at the geometry it was priced against."
	>
		{#snippet columns({ Column })}
			<Column name="revision" />
			<Column name="status" />
			<Column name="stitched_at" label="Stitched" />
			<Column name="platform_area_m2" label="Platform m²" />
			<Column name="mean_fill_depth_m" label="Mean depth m" />
			<Column name="sand_fill_m3" label="Sand m³" />
			<Column name="dredged_fill_m3" label="Dredged m³" />
			<Column name="rock_armor_m3" label="Armour m³" />
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
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="Reclamation"
		title="Projects"
		description="Three documents per project become one 3D site solid, and that solid becomes the take-off."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Bound size="full" pad="none" class="px-4 py-2 sm:px-6">
		<Tabs
			lazyLoad={false}
			variant="underline"
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
	</Bound>
</Cover>
