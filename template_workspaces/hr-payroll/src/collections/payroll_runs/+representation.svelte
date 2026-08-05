<script lang="ts">
	/**
	 * Creating a payroll run is choosing two facts: which company, and which period.
	 *
	 * Everything else on the record — the attendance window, the pay date, the configuration hash
	 * and the lifecycle — is derived by the create hook, which is the only place that can see the
	 * whole governing configuration. The window shown here comes from the engine's own
	 * `resolveWindow`, so the operator reads the same cutoff rule the run will be built with rather
	 * than a second derivation of it.
	 */
	import { client } from '$pod/client';
	import type { RepresentationProps } from './$types.js';
	import { CollectionForm } from '@norbital-ai/ui/collection-form';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Grid, Stack } from '@norbital-ai/ui/layout';
	import PayrollRunRepresentation from './payroll-run-representation.svelte';
	import { resolveWindow } from './lib/period.js';
	import { formatCalendarDate } from '../../lib/ui/display-formatters.js';

	let { record, close, refresh }: RepresentationProps = $props();

	const OFFERED_PERIODS = Array.from(
		{ length: 12 },
		(_value, index) => `2026-${String(index + 1).padStart(2, '0')}`
	);

	// Companies must be live. Runs are intentionally not filtered by approval state: a provisional
	// row still occupies the physical company/period key and must not be offered a second time.
	const companiesQuery = client.db.companies.findMany({
		where: { norbital_approval_id: { isNull: true } },
		orderBy: { name: 'asc' },
		limit: 500
	});
	const jurisdictionsQuery = client.db.jurisdictions.findMany({
		where: { norbital_approval_id: { isNull: true } },
		limit: 500
	});
	const runsQuery = client.db.payroll_runs.findMany({
		orderBy: { period: 'desc' },
		limit: 1000
	});

	let companyId = $state<string | null>(null);
	let period = $state<string | null>(null);

	const companies = $derived(companiesQuery.current ?? []);
	const currencyByJurisdiction = $derived(
		new Map(
			(jurisdictionsQuery.current ?? []).map((jurisdiction) => [
				jurisdiction.norbital_id,
				jurisdiction.currency
			])
		)
	);
	const companyOptions = $derived(
		companies.flatMap((company) => {
			const currency = currencyByJurisdiction.get(company.jurisdiction_id);
			// Without its jurisdiction a company has no currency, and payroll has nothing to pay in.
			if (!currency) return [];
			return [
				{
					value: company.norbital_id,
					label: `${company.name} · ${currency}`,
					search_term: `${company.name} ${company.registration_number} ${currency}`
				}
			];
		})
	);
	const selectedCompany = $derived(
		companies.find((company) => company.norbital_id === companyId) ?? null
	);

	const periodOptions = $derived.by(() => {
		const company = selectedCompany;
		if (!company) return [];
		const settled = new Set(
			(runsQuery.current ?? [])
				.filter((run) => run.company_id === company.norbital_id)
				.map((run) => run.period)
		);
		return OFFERED_PERIODS.filter((candidate) => !settled.has(candidate)).flatMap((candidate) => {
			// A company whose pay calendar is unusable has no offerable period; it must be fixed
			// on the company, not guessed at here.
			try {
				const window = resolveWindow(candidate, company);
				return [
					{
						value: candidate,
						label: `${candidate} · Pay ${formatCalendarDate(window.payDate)}`,
						search_term: `${candidate} ${window.attendance.start} ${window.attendance.end}`
					}
				];
			} catch {
				return [];
			}
		});
	});

	const selectedWindow = $derived.by(() => {
		const company = selectedCompany;
		if (!company || !period) return null;
		try {
			return resolveWindow(period, company);
		} catch {
			return null;
		}
	});
</script>

{#if record}
	<PayrollRunRepresentation {record} {refresh} {close} />
{:else}
	<CollectionForm
		{client}
		collection="payroll_runs"
		submitLabel="Create payroll run"
		onSubmit={async () => {
			const company = selectedCompany;
			if (!company) throw new Error('Choose a legal entity.');
			if (!period) throw new Error('Choose a payroll period.');
			const create = client.db.payroll_runs.create;
			if (!create) throw new Error('Payroll runs cannot be created in this workspace.');
			// Only the two chosen facts are sent. The window, the pay date and the configuration hash
			// are resolved by the create hook against the configuration effective at period end —
			// the client cannot see that configuration, so it has no business asserting them. The
			// window shown above is the same derivation, for the operator to read before committing.
			return create({ company_id: company.norbital_id, period });
		}}
		onAfterSubmit={close}
	>
		{#snippet children({ form })}
			<Stack gap="lg">
				<Grid gap="md" minimum="compact">
					<label class="grid gap-1.5 text-sm font-medium">
						Legal entity
						<Combobox
							ariaLabel="Legal entity"
							options={companyOptions}
							value={companyId}
							onValueChange={(value) => {
								companyId = value;
								period = null;
								form.setValues({ company_id: value });
							}}
							searchPlaceholder="Search companies…"
							emptyPlaceholder="Choose a legal entity"
							disabled={companiesQuery.loading || jurisdictionsQuery.loading}
						/>
					</label>
					<label class="grid gap-1.5 text-sm font-medium">
						Payroll period
						<Combobox
							ariaLabel="Payroll period"
							options={periodOptions}
							value={period}
							onValueChange={(value) => {
								period = value;
								form.setValues({ company_id: companyId, period: value });
							}}
							searchPlaceholder="Search payroll periods…"
							emptyPlaceholder={companyId ? 'Choose a payroll period' : 'Choose an entity first'}
							disabled={!companyId || runsQuery.loading}
						/>
					</label>
				</Grid>
				{#if selectedWindow}
					<Grid as="dl" gap="sm" minimum="compact">
						<div>
							<dt class="text-xs text-muted-foreground">Salary month</dt>
							<dd class="mt-1 font-medium tabular-nums">
								{formatCalendarDate(selectedWindow.salary.start)} → {formatCalendarDate(
									selectedWindow.salary.end
								)}
							</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Attendance window</dt>
							<dd class="mt-1 font-medium tabular-nums">
								{formatCalendarDate(selectedWindow.attendance.start)} → {formatCalendarDate(
									selectedWindow.attendance.end
								)}
							</dd>
						</div>
						<div>
							<dt class="text-xs text-muted-foreground">Pay date</dt>
							<dd class="mt-1 font-medium tabular-nums">
								{formatCalendarDate(selectedWindow.payDate)}
							</dd>
						</div>
					</Grid>
				{/if}
				<p class="text-sm text-muted-foreground">
					Creating the run builds it: the payslips and their complete component lines are written
					before this closes.
				</p>
			</Stack>
		{/snippet}
	</CollectionForm>
{/if}
