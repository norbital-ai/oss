<script lang="ts">
	/**
	 * A handover document, and the project and work front it belongs to. Both were editable uuids
	 * on the auto form.
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
	collection="asset_documents"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="title" label={t('component.title')} />
			<Field name="document_number" label={t('component.document_number')} />
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
				name="site_location_id"
				label={t('component.site_location')}
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
			<Field name="document_type" label={t('component.document_type')} />
			<Field name="asset_category" label={t('component.asset_category')} />
			<Field name="asset_tag" label={t('component.asset_tag')} />
			<Field name="status" label={t('component.status')} />
			<Field name="version" label={t('component.version')} />
			<Field name="document_url" label={t('component.location')} />
			<Column span="all"><Field name="tags" label={t('component.tags')} /></Column>
			<Column span="all"><Field name="validity_range" label={t('component.valid_for')} /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
