<script lang="ts">
	/**
	 * One rung of one scheme's ladder. Reached from the scheme it prices
	 * (`statutory_contributions/+representation.svelte` → Rate bands), because
	 * `statutory_contribution_id` is what scopes it — and what
	 * `contribution_rates_no_overlap` keys on.
	 *
	 * Authored rather than left to the schema-derived form: the scoping key is a uuid, and a uuid is
	 * a system identifier no operator can read or choose correctly.
	 */
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { RelationshipRenderer } from '@norbital-ai/ui/data-renderer/relationship';
	import { Column, Grid } from '@norbital-ai/ui/layout';

	let { record, close }: RepresentationProps = $props();
</script>

<CollectionForm
	{client}
	collection="contribution_rates"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? 'Save rate band' : 'Create rate band'}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Column span="all">
				<Field
					name="statutory_contribution_id"
					label="Statutory scheme"
					renderer={RelationshipRenderer}
					rendererProps={{
						target: 'statutory_contributions',
						options: {
							label: (contribution) =>
								[contribution.code, contribution.name]
									.filter((part) => part != null && part !== '')
									.join(' · ') || '—',
							orderBy: { sequence: 'asc' },
							limit: 500
						}
					}}
				/>
			</Column>
			<Column span="all"><Field name="selector" label="Applies to" /></Column>
			<Column span="all"><Field name="award" label="Award" /></Column>
			<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
