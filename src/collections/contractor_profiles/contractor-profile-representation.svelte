<script lang="ts">
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Stack } from '@norbital-ai/ui/layout';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';

	let { record }: { record: Row } = $props();

	const recordId = $derived(record.norbital_id);
	const certificationsQuery = $derived(
		client.db.contractor_certifications.findMany({
			where: { contractor_profile_id: { eq: recordId } },
			orderBy: { certification_type_id: 'asc' },
			limit: 250
		})
	);
	let certificationDraft = $state<{ recordId: string; ids: string[] } | null>(null);
	let certificationSaving = $state(false);
	let certificationError = $state<string | null>(null);
	const persistedCertificationIds = $derived(
		(certificationsQuery.current ?? []).map((link) => link.certification_type_id)
	);
	const selectedCertificationIds = $derived(
		certificationDraft != null && certificationDraft.recordId === recordId
			? certificationDraft.ids
			: persistedCertificationIds
	);

	async function updateCertifications(value: string | string[] | null): Promise<void> {
		const nextIds = [...new Set(Array.isArray(value) ? value : value ? [value] : [])];
		certificationDraft = { recordId, ids: nextIds };
		certificationSaving = true;
		certificationError = null;
		try {
			const create = client.db.contractor_certifications.create;
			const remove = client.db.contractor_certifications.delete;
			if (!create || !remove) throw new Error('Certification editing is unavailable.');
			const currentLinks = certificationsQuery.current ?? [];
			const nextSet = new Set(nextIds);
			const currentIds = new Set(currentLinks.map((link) => link.certification_type_id));

			await Promise.all(
				currentLinks
					.filter((link) => !nextSet.has(link.certification_type_id))
					.map((link) => remove(link.norbital_id))
			);
			await Promise.all(
				nextIds
					.filter((certificationTypeId) => !currentIds.has(certificationTypeId))
					.map((certificationTypeId) =>
						create({
							contractor_profile_id: recordId,
							certification_type_id: certificationTypeId
						})
					)
			);
			await certificationsQuery.refresh();
			certificationDraft = null;
		} catch (cause) {
			certificationDraft = null;
			certificationError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			certificationSaving = false;
		}
	}
</script>

<CollectionForm {client} collection="contractor_profiles" {recordId} defaultValues={record}>
	{#snippet children({ Field })}
		<Stack gap="lg">
			<Stack gap="none">
				<h3 id="contractor-profile-heading" class="text-sm font-semibold">Company and access</h3>
				<p class="text-sm text-muted-foreground">
					The linked portal user receives assignments; certification holdings control eligibility.
				</p>
			</Stack>
			<Stack gap="md">
				<Field name="company_name" />
				<Field
					name="user_id"
					label="Portal user"
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
				<Stack as="fieldset" gap="xs">
					<legend class="text-sm font-medium">Certifications held</legend>
					<RelationshipRenderer
						target="certification_types"
						value={selectedCertificationIds}
						multiple
						options={{
							label: (certification) => String(certification.name ?? '—'),
							where: { active: { eq: true } },
							orderBy: { name: 'asc' },
							limit: 250
						}}
						placeholder="Select certifications…"
						disabled={certificationSaving || certificationsQuery.loading}
						onValueChange={(value) => void updateCertifications(value)}
					/>
					<p class="text-xs text-muted-foreground">
						{certificationSaving
							? 'Saving certification links…'
							: 'Used to check dispatch eligibility.'}
					</p>
					{#if certificationError}
						<p class="text-xs text-destructive" role="alert">{certificationError}</p>
					{/if}
				</Stack>
			</Stack>
		</Stack>
	{/snippet}
</CollectionForm>
