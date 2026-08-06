<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { MatrixRenderer, type MatrixColumn } from '@norbital-ai/ui/data-renderer/matrix';
	import { Column, Grid, Stack } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	interface CertificationRequirementRow {
		id: string;
		norbital_id?: string;
		certification_type_id: string;
	}

	let { record, close }: RepresentationProps = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const certificationColumns = $derived([
		{
			key: 'certification_type_id',
			label: t('component.certification'),
			field: {
				name: 'certification_type_id',
				kind: 'uuid',
				nullable: false,
				relation: {
					name: 'certification_type',
					target: 'certification_types'
				}
			} satisfies CollectionField,
			relationOptions: {
				label: (certification) => String(certification.name ?? '—'),
				where: { active: { eq: true } },
				orderBy: { name: 'asc' },
				limit: 250
			},
			width: 320
		}
	] satisfies readonly MatrixColumn<CertificationRequirementRow>[]);

	const recordId = $derived(record?.norbital_id);
	const formDefaults = $derived(record ?? { status: 'unassigned' as const });
	const requirementsQuery = $derived(
		recordId
			? client.db.job_certification_requirements.findMany({
					where: { job_id: { eq: recordId } },
					orderBy: { certification_type_id: 'asc' },
					limit: 250
				})
			: null
	);
	let certificationDraft = $state<{
		recordId: string;
		rows: CertificationRequirementRow[];
	} | null>(null);
	let certificationSaving = $state(false);
	let certificationError = $state<string | null>(null);
	const persistedCertificationRows = $derived(
		(requirementsQuery?.current ?? []).map((requirement): CertificationRequirementRow => ({
			id: requirement.norbital_id,
			norbital_id: requirement.norbital_id,
			certification_type_id: requirement.certification_type_id
		}))
	);
	const certificationRows = $derived(
		certificationDraft != null && certificationDraft.recordId === recordId
			? certificationDraft.rows
			: persistedCertificationRows
	);

	async function updateCertificationRequirements(
		nextRows: CertificationRequirementRow[]
	): Promise<void> {
		if (!recordId || !requirementsQuery) return;

		certificationDraft = { recordId, rows: nextRows };
		const validRows = nextRows.filter((row) => row.certification_type_id.length > 0);
		const nextIds = validRows.map((row) => row.certification_type_id);
		if (new Set(nextIds).size !== nextIds.length) {
			certificationError = t('component.certification_duplicate');
			return;
		}

		const currentLinks = requirementsQuery.current ?? [];
		const unchanged =
			currentLinks.length === validRows.length &&
			currentLinks.every((link) =>
				validRows.some(
					(row) =>
						row.norbital_id === link.norbital_id &&
						row.certification_type_id === link.certification_type_id
				)
			);
		if (unchanged) {
			certificationError = null;
			return;
		}

		certificationSaving = true;
		certificationError = null;
		try {
			const createMany = client.db.job_certification_requirements.createMany;
			const remove = client.db.job_certification_requirements.delete;
			if (!createMany || !remove) throw new Error(t('component.certification_editing_unavailable'));

			await Promise.all(currentLinks.map((link) => remove(link.norbital_id)));
			if (validRows.length > 0) {
				await createMany(
					validRows.map((row) => ({
						job_id: recordId,
						certification_type_id: row.certification_type_id
					}))
				);
			}
			certificationDraft = null;
		} catch (cause) {
			certificationDraft = null;
			certificationError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			certificationSaving = false;
		}
	}
</script>

<CollectionForm
	{client}
	collection="jobs"
	{recordId}
	defaultValues={formDefaults}
	submitLabel={record ? undefined : t('component.create_job')}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid minimum="panel">
			<Field
				name="site_id"
				label={t('component.site')}
				renderer={RelationshipRenderer}
				rendererProps={{
					target: 'sites',
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
			<Field name="title" label={t('component.job_title')} />
			<Field name="nature" label={t('component.job_nature')} />
			<Field name="scheduled_for" label={t('component.scheduled_date')} />
			<Column span="all">
				<Field name="description" label={t('component.job_description_scope')} />
			</Column>
		</Grid>
		{#if record}
			<Stack as="section" gap="sm" aria-labelledby="job-certifications-heading">
				<div>
					<h3 id="job-certifications-heading" class="text-sm font-semibold">
						{t('component.required_certifications')}
					</h3>
					<p class="text-sm text-muted-foreground">
						{t('component.required_certifications_description')}
					</p>
				</div>
				<MatrixRenderer
					rows={certificationRows}
					columns={certificationColumns}
					disabled={certificationSaving || requirementsQuery?.loading === true}
					emptyMessage={t('component.no_certifications_required')}
					createRow={() => ({ id: crypto.randomUUID(), certification_type_id: '' })}
					addRowLabel={t('component.add_certification')}
					bounded={false}
					onChange={(nextRows) => void updateCertificationRequirements(nextRows)}
				/>
				<p class="text-xs text-muted-foreground">
					{certificationSaving
						? t('component.certifications_saving')
						: t('component.certifications_saved_immediately')}
				</p>
				{#if certificationError}
					<p class="text-xs text-destructive" role="alert">{certificationError}</p>
				{/if}
			</Stack>
		{:else}
			<p class="text-sm text-muted-foreground">
				{t('component.certifications_after_job')}
			</p>
		{/if}
	{/snippet}
</CollectionForm>
