<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import ContractorProfileRepresentation from './contractor-profile-representation.svelte';

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

{#if record}
	<ContractorProfileRepresentation {record} />
{:else}
	<CollectionForm
		{client}
		collection="contractor_profiles"
		submitLabel={t('component.add_contractor')}
		onAfterSubmit={close}
	>
		{#snippet children({ Field })}
			<Grid minimum="panel">
				<Field name="company_name" />
				<Field
					name="user_id"
					label={t('component.portal_user')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'user',
						options: {
							label: (record) => {
								const v = record.name;
								return v != null && v !== '' ? String(v) : '—';
							},
							orderBy: { name: 'asc' },
							limit: 500
						}
					}}
				/>
			</Grid>
		{/snippet}
	</CollectionForm>
{/if}
