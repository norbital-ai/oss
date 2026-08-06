<script lang="ts">
	/**
	 * A document filed against a project. `project_id` was an editable uuid on the auto form; it is
	 * a relationship and reads as the project's `code · name`.
	 *
	 * `document_role` only means anything for a `reconstruction` document — the stitch reads those
	 * and they change the model. Tender and reference material is filed and never parsed.
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
	collection="project_documents"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field name="title" label={t('component.title')} />
			<Field
				name="project_id"
				label={t('component.project')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'reclamation_projects',
					options: {
						label: (record) => {
							const code = record.project_code;
							const name = record.project_name;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { project_code: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field name="category" label={t('component.category')} />
			<Field name="document_role" label={t('component.document_role')} />
			<Column span="all"><Field name="document_file" label={t('component.file')} /></Column>
			<Field name="document_number" label={t('component.document_number')} />
			<Field name="revision" label={t('component.revision')} />
			<Field name="discipline" label={t('component.discipline')} />
			<Field name="status" label={t('component.status')} />
			<Field name="issued_on" label={t('component.issued_on')} />
			<Field name="issued_by" label={t('component.issued_by')} />
			<Column span="all"><Field name="tags" label={t('component.tags')} /></Column>
			<Column span="all"><Field name="notes" label={t('component.notes')} /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
