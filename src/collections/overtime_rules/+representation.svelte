<script lang="ts">
	/**
	 * What an hour beyond normal is worth in one jurisdiction. Reached from that jurisdiction
	 * (`jurisdictions/+representation.svelte` → Overtime rules), because `jurisdiction_id` is what
	 * scopes it.
	 *
	 * Authored rather than left to the schema-derived form: the scoping key is a uuid, and a uuid is
	 * a system identifier no operator can read or choose correctly.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import { Column, Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

<CollectionForm
	{client}
	collection="overtime_rules"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? t('component.save_overtime_rule') : t('component.create_overtime_rule')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="jurisdiction_id"
				label={t('component.jurisdiction')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'jurisdictions',
					options: {
						label: (jurisdiction) =>
							[jurisdiction.code, jurisdiction.name]
								.filter((part) => part != null && part !== '')
								.join(' · ') || '—',
						orderBy: { code: 'asc' },
						limit: 200
					}
				}}
			/>
			<Field name="day_type" label={t('component.day_type')} />
			<Field name="authority" />
			<Column span="all"><Field name="band" label={t('component.band')} /></Column>
			<Column span="all"><Field name="award" label={t('component.award')} /></Column>
			<Column span="all"
				><Field name="effective_range" label={t('component.effective_period')} /></Column
			>
		</Grid>
	{/snippet}
</CollectionForm>
