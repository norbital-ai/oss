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
	import { consumedReferenceText, dayKey } from '../../lib/ui/payslip-sources.js';

	let { record }: { record: Row } = $props();

	type PayslipSummary = {
		readonly payslip_employment?: {
			readonly employee_number?: string | null;
			readonly employment_employee?: { readonly name?: string | null } | null;
		} | null;
	};
	const summaryQuery = $derived(
		client.db.payslips.findFirst({
			where: { norbital_id: { eq: record.norbital_id } },
			columns: { norbital_id: true },
			with: {
				payslip_employment: {
					columns: { employee_number: true },
					with: { employment_employee: { columns: { name: true } } }
				}
			}
		})
	);
	const summary = $derived(summaryQuery.current as PayslipSummary | null | undefined);
	const employment = $derived(summary?.payslip_employment ?? null);
	const employeeName = $derived(employment?.employment_employee?.name ?? null);

	const linesQuery = $derived(
		client.db.payslip_lines.findMany({
			where: { payslip_id: { eq: record.norbital_id } },
			columns: { norbital_id: true },
			with: {
				payslip_line_source_line: {
					columns: { norbital_id: true },
					with: {
						entry_payslip_sources: {
							columns: { description: true, event_date: true }
						},
						time_entry_payslip_sources: { columns: { work_date: true } },
						leave_request_payslip_sources: {
							columns: { from_date: true, to_date: true }
						}
					}
				}
			},
			orderBy: { sequence: 'asc' },
			limit: 500
		})
	);
	type NestedSource = {
		readonly entry_payslip_sources?: {
			readonly description?: string | null;
			readonly event_date?: unknown;
		} | null;
		readonly time_entry_payslip_sources?: { readonly work_date?: unknown } | null;
		readonly leave_request_payslip_sources?: {
			readonly from_date?: unknown;
			readonly to_date?: unknown;
		} | null;
	};
	type NestedLine = {
		readonly payslip_line_source_line?: readonly NestedSource[] | null;
		readonly payslip_line_pay_component?: {
			readonly code?: string | null;
			readonly name?: string | null;
		} | null;
		readonly payslip_line_component_type?: { readonly name?: string | null } | null;
	};
	const sources = $derived(
		(linesQuery.current as readonly NestedLine[] | null | undefined)?.flatMap(
			(line) => line.payslip_line_source_line ?? []
		) ?? []
	);

	/** A component entry reads as the provenance its author wrote, else the day it happened. */
	const componentReferences = $derived(
		sources
			.flatMap((source) => (source.entry_payslip_sources ? [source.entry_payslip_sources] : []))
			.map((entry) => entry.description || dayKey(entry.event_date))
			.toSorted()
	);
	const timeEntryReferences = $derived(
		sources
			.flatMap((source) =>
				source.time_entry_payslip_sources ? [source.time_entry_payslip_sources] : []
			)
			.map((entry) => dayKey(entry.work_date))
			.toSorted()
	);
	const leaveRequestReferences = $derived(
		sources
			.flatMap((source) =>
				source.leave_request_payslip_sources ? [source.leave_request_payslip_sources] : []
			)
			.map((request) => `${dayKey(request.from_date)} → ${dayKey(request.to_date)}`)
			.toSorted()
	);

	const componentText = $derived(
		consumedReferenceText({
			loading: linesQuery.loading,
			error: linesQuery.error?.message,
			references: componentReferences
		})
	);
	const leaveRequestText = $derived(
		consumedReferenceText({
			loading: linesQuery.loading,
			error: linesQuery.error?.message,
			references: leaveRequestReferences
		})
	);
	const timeEntryText = $derived(
		consumedReferenceText({
			loading: linesQuery.loading,
			error: linesQuery.error?.message,
			references: timeEntryReferences
		})
	);

	function payComponentLabel(row: unknown, fallback: unknown): unknown {
		const component = (row as NestedLine).payslip_line_pay_component;
		return component?.code && component.name ? `${component.code} · ${component.name}` : fallback;
	}

	function componentTypeLabel(row: unknown, fallback: unknown): unknown {
		return (row as NestedLine).payslip_line_component_type?.name ?? fallback;
	}
</script>

<Scroll name="Payslip detail">
	<Stack gap="lg">
		<Stack as="section" gap="sm" aria-labelledby="payslip-summary-heading">
			<h2 id="payslip-summary-heading" class="text-xl font-semibold">
				{employeeName ?? 'Employee'}
			</h2>
			<p class="text-sm text-muted-foreground">
				{employment?.employee_number ?? 'Employment'} · {record.currency}
			</p>
			<Grid as="dl" gap="sm" minimum="compact">
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
		</Stack>

		<Stack
			as="section"
			gap="sm"
			class="border-t border-border pt-4"
			aria-labelledby="payslip-evidence-heading"
		>
			<h3 id="payslip-evidence-heading" class="text-sm font-semibold">Consumed records</h3>
			<p class="text-xs text-muted-foreground">
				The source records this payslip's lines read, written by the run that produced them.
			</p>
			<Grid as="dl" gap="sm" minimum="compact">
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
		</Stack>

		<Stack
			as="section"
			gap="sm"
			class="border-t border-border pt-4"
			aria-labelledby="payslip-lines-heading"
		>
			<h3 id="payslip-lines-heading" class="text-sm font-semibold">Line items</h3>
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
						with: {
							payslip_line_pay_component: { columns: { code: true, name: true } },
							payslip_line_component_type: { columns: { name: true } }
						},
						limit: 100
					}}
				>
					{#snippet columns({ Column })}
						<Column name="sequence" label="#" />
						<Column
							name="pay_component_id"
							label="Component"
							card="title"
							render={({ row, value }) => payComponentLabel(row, value)}
						/>
						<Column
							name="component_type_id"
							label="Type"
							card="subtitle"
							render={({ row, value }) => componentTypeLabel(row, value)}
						/>
						<Column name="quantity" render={({ value }) => formatNumeric(value)} />
						<Column name="rate" render={({ value }) => formatNumeric(value)} />
						<Column name="amount" card="badge" render={({ value }) => formatNumeric(value)} />
					{/snippet}
				</CollectionTable>
			</Bound>
		</Stack>
	</Stack>
</Scroll>
