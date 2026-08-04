<script lang="ts">
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
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

	const certificationColumns = [
		{
			key: 'certification_type_id',
			label: 'Certification',
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
	] satisfies readonly MatrixColumn<CertificationRequirementRow>[];

	let {
		record = null,
		defaultValues,
		onAfterSubmit,
		class: className
	}: {
		record?: Row | null;
		defaultValues?: Partial<Row>;
		onAfterSubmit?: (record: Row) => void | Promise<void>;
		class?: string;
	} = $props();

	const recordId = $derived(record?.norbital_id);
	const formDefaults = $derived({
		status: 'unassigned' as const,
		...defaultValues,
		...(record ?? {})
	});
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
			certificationError = 'Each certification can only be required once.';
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
			const create = client.db.job_certification_requirements.create;
			const remove = client.db.job_certification_requirements.delete;
			if (!create || !remove) throw new Error('Certification editing is unavailable.');

			await Promise.all(currentLinks.map((link) => remove(link.norbital_id)));
			await Promise.all(
				validRows.map((row) =>
					create({ job_id: recordId, certification_type_id: row.certification_type_id })
				)
			);
			await requirementsQuery.refresh();
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
	submitLabel={recordId ? undefined : 'Create job'}
	{onAfterSubmit}
	class={className}
>
	{#snippet children({ Field })}
		<Grid minimum="panel">
			<Field
				name="site_id"
				label="Site"
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
			<Field name="title" label="Job title" />
			<Field name="nature" label="Job nature" />
			<Field name="scheduled_for" label="Scheduled date" />
			<Column span="all">
				<Field name="description" label="Job description and scope" />
			</Column>
		</Grid>
		{#if recordId}
			<Stack as="section" gap="sm" aria-labelledby="job-certifications-heading">
				<div>
					<h3 id="job-certifications-heading" class="text-sm font-semibold">
						Required certifications
					</h3>
					<p class="text-sm text-muted-foreground">
						Selected from the shared catalogue and enforced when a contractor is assigned.
					</p>
				</div>
				<MatrixRenderer
					rows={certificationRows}
					columns={certificationColumns}
					disabled={certificationSaving || requirementsQuery?.loading === true}
					emptyMessage="No certifications required."
					createRow={() => ({ id: crypto.randomUUID(), certification_type_id: '' })}
					addRowLabel="Add certification"
					bounded={false}
					onChange={(nextRows) => void updateCertificationRequirements(nextRows)}
				/>
				<p class="text-xs text-muted-foreground">
					{certificationSaving ? 'Saving certification requirements…' : 'Changes save immediately.'}
				</p>
				{#if certificationError}
					<p class="text-xs text-destructive" role="alert">{certificationError}</p>
				{/if}
			</Stack>
		{/if}
	{/snippet}
</CollectionForm>
