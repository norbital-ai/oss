<script lang="ts">
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { MatrixRenderer, type MatrixColumn } from '@norbital-ai/ui/data-renderer/matrix';
	import { Column, Grid } from '@norbital-ai/ui/layout';
	import { watch } from 'runed';

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
				label: (certification) => String(certification.name ?? certification.norbital_id),
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
		onAfterSubmit
	}: {
		record?: Row | null;
		defaultValues?: Partial<Row>;
		onAfterSubmit?: (record: Row) => void | Promise<void>;
	} = $props();

	const recordId = $derived(record?.norbital_id);
	const formDefaults = $derived({
		status: 'unassigned' as const,
		...defaultValues,
		...(record ?? {})
	});
	// svelte-ignore state_referenced_locally -- the record identity watch replaces this initial handle.
	let requirementsQuery = $state<ReturnType<
		typeof client.db.job_certification_requirements.findMany
	> | null>(
		recordId
			? client.db.job_certification_requirements.findMany({
					where: { job_id: { eq: recordId } },
					orderBy: { certification_type_id: 'asc' },
					limit: 250
				})
			: null
	);
	let certificationRows = $state<CertificationRequirementRow[]>([]);
	let certificationSaving = $state(false);
	let certificationError = $state<string | null>(null);
	const persistedCertificationRows = $derived(
		(requirementsQuery?.current ?? []).map((requirement): CertificationRequirementRow => ({
			id: requirement.norbital_id,
			norbital_id: requirement.norbital_id,
			certification_type_id: requirement.certification_type_id
		}))
	);
	const persistedCertificationKey = $derived(
		persistedCertificationRows
			.map((requirement) => `${requirement.norbital_id}:${requirement.certification_type_id}`)
			.join(',')
	);

	watch(
		() => recordId,
		(nextRecordId) => {
			requirementsQuery = nextRecordId
				? client.db.job_certification_requirements.findMany({
						where: { job_id: { eq: nextRecordId } },
						orderBy: { certification_type_id: 'asc' },
						limit: 250
					})
				: null;
			certificationRows = [];
			certificationError = null;
		},
		{ lazy: true }
	);
	watch(
		() => persistedCertificationKey,
		() => {
			if (!certificationSaving) certificationRows = persistedCertificationRows;
		}
	);

	async function updateCertificationRequirements(
		nextRows: CertificationRequirementRow[]
	): Promise<void> {
		certificationRows = nextRows;
		if (!recordId || !requirementsQuery) return;

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
			certificationRows = (requirementsQuery.current ?? []).map((requirement) => ({
				id: requirement.norbital_id,
				norbital_id: requirement.norbital_id,
				certification_type_id: requirement.certification_type_id
			}));
		} catch (cause) {
			certificationRows = persistedCertificationRows;
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
>
	{#snippet children({ Field })}
		<Grid minimum="panel">
			<Field name="site_id" label="Site" />
			<Field name="title" label="Job title" />
			<Field name="nature" label="Job nature" />
			<Field name="scheduled_for" label="Scheduled date" />
			<Column span="all">
				<Field name="description" label="Job description and scope" />
			</Column>
		</Grid>
		{#if recordId}
			<section aria-labelledby="job-certifications-heading" class="grid gap-3">
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
			</section>
		{/if}
	{/snippet}
</CollectionForm>
