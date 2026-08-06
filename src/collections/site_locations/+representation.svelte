<script lang="ts">
	/**
	 * A work front inside a project, optionally nested under another. `project_id` and
	 * `parent_location_id` were both editable uuids on the auto form; the parent reads as its own
	 * `code · name`, which is the only way to tell two zones apart.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="site_locations"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="location_name" label={t('component.location_name')} />
			<Field name="location_code" label={t('component.location_code')} />
			<Field
				name="project_id"
				label={t('component.project')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'projects',
					options: {
						label: (record) => {
							const code = record.project_number;
							const name = record.project_name;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { project_number: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field
				name="parent_location_id"
				label={t('component.parent_location')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'site_locations',
					options: {
						label: (record) => {
							const code = record.location_code;
							const name = record.location_name;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { location_code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="location_type" label={t('component.location_type')} />
			<Field name="grid_reference" label={t('component.grid_reference')} />
			<!-- A text() element id from the BIM model, not a system uuid: it is the value an operator
			matches against the model, so here the id is the answer rather than a key to one. -->
			<!-- stupidity:allow UI17 -->
			<Field name="bim_model_element_id" label={t('component.bim_element')} />
			<Column span="all"><Field name="description" label={t('component.description')} /></Column>
			<Column span="all"><Field name="coordinates" label={t('component.coordinates')} /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
