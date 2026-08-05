<script lang="ts">
	/**
	 * The statutory ceiling on overtime hours in one jurisdiction. Reached from that jurisdiction
	 * (`jurisdictions/+representation.svelte` → Overtime limits), because `jurisdiction_id` is what
	 * scopes it.
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
	collection="overtime_limits"
	recordId={record?.norbital_id}
	defaultValues={record ?? undefined}
	submitLabel={record ? 'Save overtime limit' : 'Create overtime limit'}
	onAfterSubmit={record ? undefined : close}
>
	{#snippet children({ Field })}
		<Grid gap="md" minimum="panel">
			<Field
				name="jurisdiction_id"
				label="Jurisdiction"
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
			<Field name="period" label="Measured per" />
			<Field name="max_hours" label="Maximum hours" />
			<Field name="on_exceed" label="On exceed" />
			<Column span="all"><Field name="authority" /></Column>
			<Column span="all"><Field name="effective_range" label="Effective period" /></Column>
		</Grid>
	{/snippet}
</CollectionForm>
