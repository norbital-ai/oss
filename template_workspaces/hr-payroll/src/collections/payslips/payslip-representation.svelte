<script lang="ts">
	/** One person's settlement. Every row below is the physical payslip-to-component junction. */
	import { client } from '$pod/client';
	import type { Row } from './$types.js';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Bound, Grid, Stack } from '@norbital-ai/ui/layout';
	import { formatCalendarDate, formatNumeric } from '../../lib/ui/display-formatters.js';

	let { record }: { record: Row } = $props();

	type PayslipSummary = {
		readonly payslip_employment?: {
			readonly employee_number?: string | null;
			readonly employment_employee?: { readonly name?: string | null } | null;
		} | null;
	};
	type NestedLine = {
		readonly payslip_line_pay_component?: {
			readonly code?: string | null;
			readonly name?: string | null;
		} | null;
		readonly entry_payslip_lines?: {
			readonly description?: string | null;
			readonly event_date?: string | null;
		} | null;
		readonly payslip_line_statutory_contribution?: {
			readonly code?: string | null;
			readonly name?: string | null;
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

	function componentLabel(row: unknown): string {
		const line = row as NestedLine;
		const component = line.payslip_line_pay_component;
		if (component?.code)
			return component.name ? `${component.code} · ${component.name}` : component.code;
		const statutory = line.payslip_line_statutory_contribution;
		if (statutory?.code)
			return statutory.name ? `${statutory.code} · ${statutory.name}` : statutory.code;
		return 'Derived line';
	}

	function entryLabel(row: unknown): string {
		const entry = (row as NestedLine).entry_payslip_lines;
		if (entry?.description) return entry.description;
		return entry?.event_date == null ? '—' : formatCalendarDate(entry.event_date);
	}
</script>

<Stack gap="lg">
	<Stack as="section" gap="sm" aria-labelledby="payslip-summary-heading">
		<h2 id="payslip-summary-heading" class="text-xl font-semibold">
			{employment?.employment_employee?.name ?? 'Employee'}
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
				<dd class="mt-1 font-semibold tabular-nums">{formatNumeric(record.total_deductions)}</dd>
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
		aria-labelledby="payslip-lines-heading"
	>
		<h3 id="payslip-lines-heading" class="text-sm font-semibold">Component breakdown</h3>
		<p class="text-xs text-muted-foreground">
			Each row is the direct, queryable link from this payslip to its pay component, input entry, or
			statutory scheme.
		</p>
		<Bound size="standard">
			<CollectionTable
				{client}
				collection="payslip_lines"
				title="Component breakdown"
				description="The settled lines that make up this payslip."
				features={{ create: false }}
				query={{
					where: { payslip_id: { eq: record.norbital_id } },
					orderBy: { sequence: 'asc' },
					with: {
						payslip_line_pay_component: { columns: { code: true, name: true } },
						entry_payslip_lines: { columns: { description: true, event_date: true } },
						payslip_line_statutory_contribution: { columns: { code: true, name: true } }
					},
					limit: 200
				}}
			>
				{#snippet columns({ Column })}
					<Column name="sequence" label="#" />
					<Column
						name="pay_component_id"
						label="Component"
						card="title"
						render={({ row }) => componentLabel(row)}
					/>
					<Column name="component" label="Line kind" card="subtitle" />
					<Column
						name="component_entry_id"
						label="Input entry"
						render={({ row }) => entryLabel(row)}
					/>
					<Column name="bucket" card="badge" />
					<Column name="quantity" render={({ value }) => formatNumeric(value)} />
					<Column name="rate" render={({ value }) => formatNumeric(value)} />
					<Column name="amount" card="badge" render={({ value }) => formatNumeric(value)} />
				{/snippet}
			</CollectionTable>
		</Bound>
	</Stack>
</Stack>
