<script lang="ts">
	/**
	 * One person's settlement for one run, and — the point of this surface — the source records the
	 * calculation actually read.
	 *
	 * Provenance is reached the way it is stored: the payslip's lines, then the link rows each line
	 * wrote. Nothing here recomputes a figure; it only says which entry, which clocked day and which
	 * leave request the stored number came from.
	 */
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Grid, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { formatNumeric } from '../../lib/ui/display-formatters.js';
	import {
		consumedRecordIds,
		consumedReferenceText,
		dayKey
	} from '../../lib/ui/payslip-sources.js';

	let { record }: { record: Row } = $props();

	const employmentQuery = $derived(
		client.db.employments.findFirst({ where: { norbital_id: { eq: record.employment_id } } })
	);
	const employment = $derived(employmentQuery.current);
	const employeeQuery = $derived(
		employment
			? client.db.employees.findFirst({ where: { norbital_id: { eq: employment.employee_id } } })
			: null
	);
	const employeeName = $derived(employeeQuery?.current?.name ?? null);

	// A line's component and type columns hold uuids. Both catalogues are small, so they are loaded
	// once here and the label is resolved from memory rather than by mounting a lookup per row; a
	// miss falls back to the raw id so an unloaded label never reads as missing data.
	const payComponentsQuery = client.db.pay_components.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const payComponentLabelsById = $derived(
		new Map(
			(payComponentsQuery.current ?? []).map((component) => [
				component.norbital_id,
				`${component.code} · ${component.name}`
			])
		)
	);
	const componentTypesQuery = client.db.component_types.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 200
	});
	const componentTypeLabelsById = $derived(
		new Map((componentTypesQuery.current ?? []).map((type) => [type.norbital_id, type.name]))
	);

	const linesQuery = $derived(
		client.db.payslip_lines.findMany({
			where: { payslip_id: { eq: record.norbital_id } },
			orderBy: { sequence: 'asc' },
			limit: 500
		})
	);
	const lineIds = $derived((linesQuery.current ?? []).map((line) => line.norbital_id));
	const sourcesQuery = $derived(
		lineIds.length === 0
			? null
			: client.db.payslip_line_sources.findMany({
					where: { payslip_line_id: { in: lineIds } },
					limit: 2000
				})
	);
	const sourcesLoading = $derived(
		linesQuery.loading || (sourcesQuery ? sourcesQuery.loading : lineIds.length > 0)
	);
	const sourcesError = $derived(linesQuery.error?.message ?? sourcesQuery?.error?.message ?? null);
	const consumed = $derived(consumedRecordIds(sourcesQuery?.current ?? []));

	const entriesQuery = $derived(
		consumed.entryIds.length === 0
			? null
			: client.db.component_entries.findMany({
					where: { norbital_id: { in: [...consumed.entryIds] } },
					limit: 500
				})
	);
	const timeEntriesQuery = $derived(
		consumed.timeEntryIds.length === 0
			? null
			: client.db.time_entries.findMany({
					where: { norbital_id: { in: [...consumed.timeEntryIds] } },
					orderBy: { work_date: 'asc' },
					limit: 500
				})
	);
	const leaveRequestsQuery = $derived(
		consumed.leaveRequestIds.length === 0
			? null
			: client.db.leave_requests.findMany({
					where: { norbital_id: { in: [...consumed.leaveRequestIds] } },
					orderBy: { from_date: 'asc' },
					limit: 500
				})
	);

	/** A component entry reads as the provenance its author wrote, else the day it happened. */
	const componentReferences = $derived(
		(entriesQuery?.current ?? [])
			.map((entry) => entry.description || dayKey(entry.event_date))
			.toSorted()
	);
	const timeEntryReferences = $derived(
		(timeEntriesQuery?.current ?? []).map((entry) => dayKey(entry.work_date)).toSorted()
	);
	const leaveRequestReferences = $derived(
		(leaveRequestsQuery?.current ?? [])
			.map((request) => `${dayKey(request.from_date)} → ${dayKey(request.to_date)}`)
			.toSorted()
	);

	const componentText = $derived(
		consumedReferenceText({
			loading: sourcesLoading || (entriesQuery?.loading ?? false),
			error: sourcesError ?? entriesQuery?.error?.message,
			references: componentReferences
		})
	);
	const leaveRequestText = $derived(
		consumedReferenceText({
			loading: sourcesLoading || (leaveRequestsQuery?.loading ?? false),
			error: sourcesError ?? leaveRequestsQuery?.error?.message,
			references: leaveRequestReferences
		})
	);
	const timeEntryText = $derived(
		consumedReferenceText({
			loading: sourcesLoading || (timeEntriesQuery?.loading ?? false),
			error: sourcesError ?? timeEntriesQuery?.error?.message,
			references: timeEntryReferences
		})
	);
</script>

<Scroll name="Payslip detail" class="h-full">
	<Stack gap="lg">
		<section aria-labelledby="payslip-summary-heading">
			<h2 id="payslip-summary-heading" class="text-xl font-semibold">
				{employeeName ?? 'Employee'}
			</h2>
			<p class="mt-1 text-sm text-muted-foreground">
				{employment?.employee_number ?? 'Employment'} · {record.currency}
			</p>
			<Grid as="dl" class="mt-4" gap="sm" minimum="compact">
				<div>
					<dt class="text-xs text-muted-foreground">Gross</dt>
					<dd class="mt-1 font-semibold tabular-nums">{formatNumeric(record.gross)}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Deductions</dt>
					<dd class="mt-1 font-semibold tabular-nums">
						{formatNumeric(record.total_deductions)}
					</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Net</dt>
					<dd class="mt-1 text-lg font-bold tabular-nums">{formatNumeric(record.net)}</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Employer cost</dt>
					<dd class="mt-1 font-semibold tabular-nums">{formatNumeric(record.employer_cost)}</dd>
				</div>
			</Grid>
		</section>

		<section aria-labelledby="payslip-evidence-heading" class="border-t border-border pt-4">
			<h3 id="payslip-evidence-heading" class="text-sm font-semibold">Consumed records</h3>
			<p class="mt-0.5 text-xs text-muted-foreground">
				The source records this payslip's lines read, written by the run that produced them.
			</p>
			<Grid as="dl" class="mt-3" gap="sm" minimum="compact">
				<div>
					<dt class="text-xs text-muted-foreground">Pay components</dt>
					<dd class="mt-1 text-sm">
						<span aria-live="polite" class="break-words">{componentText}</span>
					</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Leave requests</dt>
					<dd class="mt-1 text-sm">
						<span aria-live="polite" class="break-words">{leaveRequestText}</span>
					</dd>
				</div>
				<div>
					<dt class="text-xs text-muted-foreground">Time entries</dt>
					<dd class="mt-1 text-sm">
						<span aria-live="polite" class="break-words">{timeEntryText}</span>
					</dd>
				</div>
			</Grid>
		</section>

		<section aria-labelledby="payslip-lines-heading" class="border-t border-border pt-4">
			<h3 id="payslip-lines-heading" class="mb-3 text-sm font-semibold">Line items</h3>
			<Bound size="standard">
				<CollectionTable
					{client}
					collection="payslip_lines"
					title="Line items"
					description="Every plane of input arrives here converted to money, in component-type sequence."
					features={{ create: false }}
					query={{
						where: { payslip_id: { eq: record.norbital_id } },
						orderBy: { sequence: 'asc' },
						limit: 100
					}}
				>
					{#snippet columns({ Column })}
						<Column name="sequence" label="#" />
						<Column
							name="pay_component_id"
							label="Component"
							card="title"
							render={({ value }) => payComponentLabelsById.get(String(value)) ?? value}
						/>
						<Column
							name="component_type_id"
							label="Type"
							card="subtitle"
							render={({ value }) => componentTypeLabelsById.get(String(value)) ?? value}
						/>
						<Column name="quantity" render={({ value }) => formatNumeric(value)} />
						<Column name="rate" render={({ value }) => formatNumeric(value)} />
						<Column name="amount" card="badge" render={({ value }) => formatNumeric(value)} />
					{/snippet}
				</CollectionTable>
			</Bound>
		</section>
	</Stack>
</Scroll>
