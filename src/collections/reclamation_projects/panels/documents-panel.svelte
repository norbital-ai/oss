<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import type { DocumentProvenance } from '../../../lib/reclamation/types.js';

	/**
	 * Everything the project carries, in two groups.
	 *
	 * The three primary documents are the reconstruction's inputs and live on the
	 * project record. Everything else is attached here, and its category decides
	 * whether the stitch reads it or simply files it.
	 */
	let {
		projectId,
		slots,
		provenance
	}: {
		projectId: string;
		slots: readonly {
			readonly kind: string;
			readonly label: string;
			readonly uploaded: boolean;
			readonly hint: string;
		}[];
		provenance: readonly DocumentProvenance[];
	} = $props();

	function number(value: number, digits = 0): string {
		return value.toLocaleString(undefined, { maximumFractionDigits: digits });
	}
</script>

<Stack gap="lg" class="pb-4">
	<Stack as="section" gap="sm">
		<div class="border-b pb-2">
			<h3 class="text-sm font-semibold">Reconstruction inputs</h3>
			<p class="text-xs text-muted-foreground">
				All three are required. Elevations come from the sections, plan extents from the floor plan,
				and the existing bed from the survey. Edit the project record to attach or replace one.
			</p>
		</div>
		<div class="divide-y rounded-md border bg-card">
			{#each slots as slot (slot.kind)}
				{@const source = provenance.find((entry) => entry.kind === slot.kind)}
				<div class="p-3">
					<Inline align="start" justify="between" gap="sm">
						<p class="text-sm font-medium">{slot.label}</p>
						<span
							class={slot.uploaded
								? 'shrink-0 text-xs text-muted-foreground'
								: 'shrink-0 text-xs font-medium text-destructive'}
						>
							{slot.uploaded ? (source?.format ?? 'attached') : 'missing'}
						</span>
					</Inline>
					{#if source}
						<p class="mt-1 truncate text-xs text-muted-foreground" title={source.fileName ?? ''}>
							{source.fileName ?? 'unnamed'} · {number(source.byteSize / 1024)} kB
						</p>
						<p class="mt-0.5 text-xs text-muted-foreground">{source.summary}</p>
						<p class="mt-0.5 font-mono text-tiny text-muted-foreground">
							sha256 {source.sha256.slice(0, 16)}…
						</p>
					{:else}
						<p class="mt-1 text-xs text-muted-foreground">{slot.hint}</p>
					{/if}
				</div>
			{/each}
		</div>
	</Stack>

	<Stack as="section" gap="sm">
		<div class="border-b pb-2">
			<h3 class="text-sm font-semibold">Further reconstruction documents</h3>
			<p class="text-xs text-muted-foreground">
				Extra section sheets and surveys that also feed the model. Another perimeter section is the
				most useful thing you can add: it replaces a stretch of interpolation with measurement.
				Saving one re-runs the stitch.
			</p>
		</div>
		<!-- Both tables read project_documents, so each names its own view: the -->
		<!-- default is one view per collection, and it is also the key column -->
		<!-- state persists under. -->
		<CollectionTable
			{client}
			collection="project_documents"
			view="reclamation_projects:project_documents:reconstruction"
			query={{
				where: { project_id: { eq: projectId }, category: { eq: 'reconstruction' } },
				limit: 50
			}}
		>
			{#snippet columns({ Column })}
				<Column name="title" minWidth={200} />
				<Column name="document_role" label="Role" />
				<Column name="document_number" label="Number" />
				<Column name="revision" />
				<Column name="status" />
			{/snippet}
			{#snippet ListCard(document)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">{document.title}</p>
					<span class="shrink-0 text-xs text-muted-foreground">{document.document_role}</span>
				</Inline>
			{/snippet}
		</CollectionTable>
	</Stack>

	<Stack as="section" gap="sm">
		<div class="border-b pb-2">
			<h3 class="text-sm font-semibold">Tender and reference</h3>
			<p class="text-xs text-muted-foreground">
				Filed against the project and never parsed: tender returns, correspondence, permits, method
				statements. Nothing here can change a quantity.
			</p>
		</div>
		<CollectionTable
			{client}
			collection="project_documents"
			view="reclamation_projects:project_documents:tender"
			query={{
				where: { project_id: { eq: projectId }, category: { in: ['tender', 'reference'] } },
				limit: 100
			}}
		>
			{#snippet columns({ Column })}
				<Column name="title" minWidth={200} />
				<Column name="category" />
				<Column name="discipline" />
				<Column name="document_number" label="Number" />
				<Column name="revision" />
				<Column name="issued_on" label="Issued" />
				<Column name="issued_by" label="By" />
				<Column name="status" />
			{/snippet}
			{#snippet ListCard(document)}
				<Inline align="start" justify="between" gap="sm">
					<p class="truncate font-medium">{document.title}</p>
					<span class="shrink-0 text-xs text-muted-foreground">{document.category}</span>
				</Inline>
				<p class="mt-1 truncate text-sm text-muted-foreground">
					{document.document_number ?? 'no number'} · {document.status ?? 'no status'}
				</p>
			{/snippet}
		</CollectionTable>
	</Stack>
</Stack>
