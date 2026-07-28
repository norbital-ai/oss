<script lang="ts">
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import { watch } from 'runed';

	let { record }: { record: Row } = $props();

	const recordId = $derived(record.norbital_id);
	// svelte-ignore state_referenced_locally -- the identity watch replaces this initial handle.
	let certificationsQuery = $state(
		client.db.contractor_certifications.findMany({
			where: { contractor_profile_id: { eq: recordId } },
			orderBy: { certification_type_id: 'asc' },
			limit: 250
		})
	);
	let selectedCertificationIds = $state<string[]>([]);
	let certificationSaving = $state(false);
	let certificationError = $state<string | null>(null);
	const persistedCertificationIds = $derived(
		(certificationsQuery.current ?? []).map((link) => link.certification_type_id)
	);
	const persistedCertificationKey = $derived(persistedCertificationIds.join(','));

	watch(
		() => recordId,
		(nextRecordId) => {
			certificationsQuery = client.db.contractor_certifications.findMany({
				where: { contractor_profile_id: { eq: nextRecordId } },
				orderBy: { certification_type_id: 'asc' },
				limit: 250
			});
			selectedCertificationIds = [];
			certificationError = null;
		},
		{ lazy: true }
	);
	watch(
		() => persistedCertificationKey,
		() => {
			if (!certificationSaving) selectedCertificationIds = persistedCertificationIds;
		}
	);

	async function updateCertifications(value: string | string[] | null): Promise<void> {
		const nextIds = [...new Set(Array.isArray(value) ? value : value ? [value] : [])];
		selectedCertificationIds = nextIds;
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
		} catch (cause) {
			selectedCertificationIds = persistedCertificationIds;
			certificationError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			certificationSaving = false;
		}
	}
</script>

<CollectionForm {client} collection="contractor_profiles" {recordId} defaultValues={record}>
	{#snippet children({ Field })}
		<div class="grid gap-6">
			<div>
				<h3 id="contractor-profile-heading" class="text-sm font-semibold">Company and access</h3>
				<p class="text-sm text-muted-foreground">
					The linked portal user receives assignments; certification holdings control eligibility.
				</p>
			</div>
			<div class="grid gap-4">
				<Field name="company_name" />
				<Field name="user_id" label="Portal user" />
				<fieldset class="grid gap-1.5">
					<legend class="text-sm font-medium">Certifications held</legend>
					<div>
						<RelationshipRenderer
							target="certification_types"
							value={selectedCertificationIds}
							multiple
							options={{
								label: (certification) => String(certification.name ?? certification.norbital_id),
								where: { active: { eq: true } },
								orderBy: { name: 'asc' },
								limit: 250
							}}
							placeholder="Select certifications…"
							disabled={certificationSaving || certificationsQuery.loading}
							onValueChange={(value) => void updateCertifications(value)}
						/>
					</div>
					<p class="text-xs text-muted-foreground">
						{certificationSaving
							? 'Saving certification links…'
							: 'Used to check dispatch eligibility.'}
					</p>
					{#if certificationError}
						<p class="text-xs text-destructive" role="alert">{certificationError}</p>
					{/if}
				</fieldset>
			</div>
		</div>
	{/snippet}
</CollectionForm>
