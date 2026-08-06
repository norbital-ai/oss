<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Cover } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';

	const { t } = useI18n<TenantI18nKeys>();
</script>

<svelte:head>
	<title>Construction Reference Matrix</title>
	<meta name="description" content="Maintain the BIM reference matrix." />
	<meta name="pod:icon" content="lucide:grid-3x3" />
</svelte:head>

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.construction_settings_reference_matrix.eyebrow')}
		title={t('app.construction_settings_reference_matrix.header_title')}
		description={t('app.construction_settings_reference_matrix.header_description')}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Bound size="full" inset>
		<CollectionTable
			{client}
			collection="bim_reference_matrix"
			view="construction_reference_matrix"
		>
			{#snippet columns({ Column })}
				<Column name="reference_name" />
				<Column name="reference_code" />
				<Column name="category" />
				<Column name="subcategory" />
				<Column name="unit_of_measure" />
				<Column name="rate" />
				<Column name="embodied_carbon_per_unit" />
				<Column name="carbon_unit" />
			{/snippet}
		</CollectionTable>
	</Bound>
</Cover>
