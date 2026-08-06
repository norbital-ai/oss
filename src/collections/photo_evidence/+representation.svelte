<script lang="ts">
	/**
	 * One photo and its integrity result, read only.
	 *
	 * Nothing here is written by hand — the ingest pipeline hashes the image and records what it
	 * matched — so this panel explains a result rather than offering to change one. The auto form
	 * offered all four uuid columns as editable text boxes: the two links, the stored image, and the
	 * list of evidence this photo duplicates.
	 *
	 * `matched_evidence_ids` points back at this same collection, so each match reads as the other
	 * photo's own `summary` — which is why that column had to exist before this panel could.
	 */
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();
</script>

<svelte:head>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/field-operations/record-media/photo_evidence-banner.svg"
	/>
</svelte:head>

{#if record}
	<CollectionForm
		{client}
		collection="photo_evidence"
		recordId={record.norbital_id}
		defaultValues={record}
		disabled
	>
		{#snippet children({ Field })}
			<Grid minimum="compact">
				<!-- A file() column: DataRenderer resolves a file field against document_asset and paints
				the asset's own file name, so no id reaches the operator. -->
				<!-- stupidity:allow UI17 -->
				<Column span="all"><Field name="document_asset_id" label={t('component.photo')} /></Column>
				<Field
					name="job_assignment_id"
					label={t('component.job_assignment')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'job_assignments',
						options: {
							label: (record) => {
								const dispatched = record.dispatched_at;
								const when = dispatched == null ? null : String(dispatched).slice(0, 10);
								return (
									[when, record.status].filter((part) => part != null && part !== '').join(' · ') ||
									'—'
								);
							},
							orderBy: { dispatched_at: 'desc' },
							limit: 500
						}
					}}
				/>
				<Field
					name="variation_request_id"
					label={t('component.variation_request')}
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'variation_requests',
						options: {
							label: (record) =>
								record.title != null && record.title !== '' ? String(record.title) : '—',
							orderBy: { requested_at: 'desc' },
							limit: 500
						}
					}}
				/>
				<Column span="all"><Field name="source" label={t('component.source')} /></Column>
				<Column span="all"><Field name="flags" label={t('component.integrity_flags')} /></Column>
				<Column span="all">
					<Field
						name="matched_evidence_ids"
						label={t('component.duplicates_of')}
						renderer={RelationshipRenderer}
						rendererProps={{
							target: 'photo_evidence',
							multiple: true,
							options: {
								label: (record) =>
									record.summary != null && record.summary !== '' ? String(record.summary) : '—',
								limit: 500
							}
						}}
					/>
				</Column>
			</Grid>
		{/snippet}
	</CollectionForm>
{:else}
	<p class="text-sm text-muted-foreground">
		{t('component.evidence_write_only')}
	</p>
{/if}
