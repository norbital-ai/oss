<script lang="ts">
	/**
	 * A contractor and a certification they hold. Both sides are relationships: without this file
	 * the auto `CollectionForm` is two uuid text boxes and nothing else.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="contractor_certifications"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="compact">
			<Field
				name="contractor_profile_id"
				label={t('component.contractor')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'contractor_profiles',
					options: {
						label: (record) =>
							record.company_name != null && record.company_name !== ''
								? String(record.company_name)
								: '—',
						orderBy: { company_name: 'asc' },
						limit: 500
					}
				}}
			/>
			<Field
				name="certification_type_id"
				label={t('component.certification')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'certification_types',
					options: {
						label: (record) => {
							const code = record.code;
							const name = record.name;
							if (code && name) return `${code} · ${name}`;
							return name != null && name !== '' ? String(name) : '—';
						},
						orderBy: { code: 'asc' },
						limit: 500
					}
				}}
			/>
		</Grid>
	{/snippet}
</CollectionForm>
