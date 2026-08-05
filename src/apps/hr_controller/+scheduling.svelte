<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Button } from '@norbital-ai/ui/button';
	import { Badge } from '@norbital-ai/ui/badge';
	import { Cluster, Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { toast } from 'svelte-sonner';
	import { formatHolidayScope } from '../../lib/ui/display-formatters.js';
	import { runWorkbookImport } from '../../lib/ui/workbook-import.js';
	import { rosterImportPayload } from '../../collections/roster_entries/lib/import-workbook.js';
	import {
		calendarDayKey,
		monthKey,
		shiftMonthKey,
		todayKey,
		todayInstant
	} from '../../lib/ui/calendar.js';
	import RosterMonthBoard from '../../lib/ui/roster/roster-month-board.svelte';
	import RosterPersonCalendar from '../../lib/ui/roster/roster-person-calendar.svelte';
	import {
		STATUS_PRESENTATION,
		buildRosterMonth,
		summarizeRosterMonth,
		type DayStatus
	} from '../../lib/ui/roster/roster-month.js';

	let companyId = $state<string | null>(null);
	let month = $state<string>(monthKey(todayKey()));
	let personId = $state<string | null>(null);
	let publishing = $state(false);

	const today = todayKey();
	const activeRange = { effective_range: { contains_date: todayInstant() } } as const;
	const approved = { norbital_approval_id: { isNull: true } } as const;

	const companiesQuery = client.db.companies.findMany({
		where: { ...approved, ...activeRange },
		orderBy: { name: 'asc' },
		limit: 500
	});
	const companies = $derived(companiesQuery.current ?? []);
	const companyOptions = $derived(
		companies.map((c) => ({
			value: c.norbital_id,
			label: c.name,
			search_term: `${c.name} ${c.registration_number ?? ''}`
		}))
	);
	const selectedCompanyId = $derived(
		companyId != null && companies.some((c) => c.norbital_id === companyId)
			? companyId
			: (companies[0]?.norbital_id ?? null)
	);
	const selectedCompany = $derived(
		companies.find((company) => company.norbital_id === selectedCompanyId) ?? null
	);

	/** The month's calendar bounds, which every dated query below is narrowed to. */
	const monthStart = $derived(`${month}-01`);
	const monthEnd = $derived(
		calendarDayKey(new Date(Date.parse(`${shiftMonthKey(month, 1)}-01T00:00:00.000Z`) - 86_400_000))
	);

	/**
	 * The attendance window the next run will settle.
	 *
	 * Read from the payroll run when one exists, because that is the window the engine actually used.
	 * Only when no run has been opened yet is it derived from the company's cut-off day, which is the
	 * same rule stated in `docs/architecture/time-overtime-and-cutoffs.md`.
	 */
	const runQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.payroll_runs.findFirst({
					where: { ...approved, company_id: { eq: selectedCompanyId }, period: { eq: month } }
				})
	);
	const cutoff = $derived.by(() => {
		const run = runQuery?.current;
		if (run?.attendance_from != null && run.attendance_to != null) {
			return { start: calendarDayKey(run.attendance_from), end: calendarDayKey(run.attendance_to) };
		}
		const cutoffDay = selectedCompany?.pay_cutoff_day;
		if (cutoffDay == null) return null;
		const day = String(Math.min(Math.max(Number(cutoffDay), 1), 28)).padStart(2, '0');
		return {
			start: `${shiftMonthKey(month, -1)}-${day}`,
			end: calendarDayKey(new Date(Date.parse(`${month}-${day}T00:00:00.000Z`) - 86_400_000))
		};
	});

	const employmentsQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.employments.findMany({
					where: { ...approved, company_id: { eq: selectedCompanyId } },
					orderBy: { employee_number: 'asc' },
					limit: 1000
				})
	);
	const employments = $derived(employmentsQuery?.current ?? []);
	const employmentIds = $derived(employments.map((employment) => employment.norbital_id));
	// One scoped query and a map, rather than a name lookup per row.
	const employeesQuery = client.db.employees.findMany({ where: approved, limit: 1000 });
	const employeeNameById = $derived(
		new Map((employeesQuery.current ?? []).map((employee) => [employee.norbital_id, employee.name]))
	);
	const people = $derived(
		employments.map((employment) => ({
			id: employment.norbital_id,
			number: employment.employee_number,
			name: employeeNameById.get(employment.employee_id) ?? '—'
		}))
	);
	const personOptions = $derived(
		people.map((person) => ({
			value: person.id,
			label: `${person.number} · ${person.name}`,
			search_term: `${person.number} ${person.name}`
		}))
	);
	const selectedPersonId = $derived(
		personId != null && people.some((person) => person.id === personId)
			? personId
			: (people[0]?.id ?? null)
	);

	const shiftsQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.shift_definitions.findMany({
					where: { ...approved, company_id: { eq: selectedCompanyId } },
					limit: 500
				})
	);
	const shiftCodeById = $derived(
		new Map((shiftsQuery?.current ?? []).map((shift) => [shift.norbital_id, shift.code]))
	);
	const shiftLabelsById = $derived(
		new Map(
			(shiftsQuery?.current ?? []).map((shift) => [
				shift.norbital_id,
				`${shift.code} · ${shift.name}`
			])
		)
	);

	const leaveTypesQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.leave_types.findMany({
					where: { ...approved, company_id: { eq: selectedCompanyId } },
					limit: 200
				})
	);
	const leaveCodeById = $derived(
		new Map((leaveTypesQuery?.current ?? []).map((type) => [type.norbital_id, type.code]))
	);

	const rosterEntriesQuery = $derived(
		employmentIds.length === 0
			? null
			: client.db.roster_entries.findMany({
					where: {
						...approved,
						employment_id: { in: employmentIds },
						work_date: { gte: monthStart, lte: monthEnd }
					},
					limit: 5000
				})
	);
	const timeEntriesQuery = $derived(
		employmentIds.length === 0
			? null
			: client.db.time_entries.findMany({
					where: {
						...approved,
						employment_id: { in: employmentIds },
						work_date: { gte: monthStart, lte: monthEnd }
					},
					limit: 5000
				})
	);
	/** Requests are stored once at `from_date`, so the window is widened to catch one spanning in. */
	const leaveQuery = $derived(
		employmentIds.length === 0
			? null
			: client.db.leave_requests.findMany({
					where: {
						...approved,
						employment_id: { in: employmentIds },
						kind: { eq: 'TIME_OFF' },
						from_date: { lte: monthEnd },
						to_date: { gte: monthStart }
					},
					limit: 2000
				})
	);
	const holidaysQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.company_holidays.findMany({
					where: {
						...approved,
						company_id: { eq: selectedCompanyId },
						date: { gte: monthStart, lte: monthEnd }
					},
					limit: 200
				})
	);

	const loading = $derived(
		Boolean(
			rosterEntriesQuery?.loading ||
			timeEntriesQuery?.loading ||
			leaveQuery?.loading ||
			holidaysQuery?.loading ||
			employmentsQuery?.loading
		)
	);

	const facts = $derived(
		buildRosterMonth({
			month,
			employmentIds,
			rosterEntries: rosterEntriesQuery?.current ?? [],
			timeEntries: timeEntriesQuery?.current ?? [],
			leaveRequests: leaveQuery?.current ?? [],
			holidays: holidaysQuery?.current ?? [],
			shiftCodeById,
			leaveCodeById,
			cutoff
		})
	);
	const summary = $derived(summarizeRosterMonth(facts));
	/** Only the statuses that need somebody to act are worth a headline figure. */
	const EXCEPTION_STATUSES: DayStatus[] = ['ABSENT', 'OPEN', 'UNROSTERED'];
	const exceptions = $derived(
		EXCEPTION_STATUSES.map((status) => ({ status, count: summary.get(status) ?? 0 })).filter(
			(entry) => entry.count > 0
		)
	);

	const rostersQuery = $derived(
		selectedCompanyId == null
			? null
			: client.db.rosters.findMany({
					where: { ...approved, company_id: { eq: selectedCompanyId }, month: { eq: month } },
					limit: 50
				})
	);
	const rosters = $derived(rostersQuery?.current ?? []);
	/**
	 * The month's draft roster, which an import lands in.
	 *
	 * A published month is frozen and the pipeline refuses one outright, so the import is offered
	 * only against a draft. The operator is told which state the month is in before they choose a
	 * file, rather than after the file has been read and sent.
	 */
	const draftRoster = $derived(rosters.find((roster) => roster.published_at == null) ?? null);
	const rosterImportBlocker = $derived(
		draftRoster != null
			? null
			: rosters.length === 0
				? `No roster is drafted for ${month}. Create the draft month first, then import into it.`
				: `Roster ${month} is published, so its entries are fixed. Re-open the month to import into it.`
	);

	async function publish(rosterId: string): Promise<void> {
		const update = client.db.rosters.update;
		if (update == null) {
			toast.error('Publishing a roster is not permitted for this role.');
			return;
		}
		publishing = true;
		try {
			await update(rosterId, { published_at: new Date() });
			toast.success(`Roster ${month} published.`);
		} catch (error) {
			// The publish gate refuses with the statutory reason, which is the whole message.
			toast.error(error instanceof Error ? error.message : 'The roster could not be published.');
		} finally {
			publishing = false;
		}
	}

	async function reopen(rosterId: string): Promise<void> {
		const update = client.db.rosters.update;
		if (update == null) {
			toast.error('Re-opening a roster is not permitted for this role.');
			return;
		}
		publishing = true;
		try {
			await update(rosterId, { published_at: null });
			toast.success(`Roster ${month} re-opened for correction.`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'The roster could not be re-opened.');
		} finally {
			publishing = false;
		}
	}
</script>

<svelte:head>
	<title>Scheduling</title>
	<meta
		name="description"
		content="Plan the monthly roster on a calendar, publish it against the statutory rules, and manage work patterns, shifts and holidays"
	/>
	<meta name="pod:icon" content="lucide:calendar-clock" />
</svelte:head>

{#snippet companyScopeActions()}
	<Cluster gap="md">
		<label class="grid gap-1.5 text-sm">
			<span class="font-medium text-muted-foreground">Legal entity</span>
			<Combobox
				ariaLabel="Legal entity"
				options={companyOptions}
				value={selectedCompanyId}
				onValueChange={(value) => {
					companyId = typeof value === 'string' ? value : (companies[0]?.norbital_id ?? null);
				}}
				emptyPlaceholder="Select legal entity…"
				searchPlaceholder="Search companies…"
				clientConfig={{
					isLoading: companiesQuery.loading,
					error: companiesQuery.error?.message ?? null
				}}
				class="min-w-[16rem]"
			/>
		</label>
		<label class="grid gap-1.5 text-sm">
			<span class="font-medium text-muted-foreground">Month</span>
			<Inline gap="xs">
				<Button
					variant="outline"
					size="icon"
					aria-label="Previous month"
					onclick={() => (month = shiftMonthKey(month, -1))}
				>
					‹
				</Button>
				<span class="min-w-[6rem] text-center text-sm font-medium tabular-nums">{month}</span>
				<Button
					variant="outline"
					size="icon"
					aria-label="Next month"
					onclick={() => (month = shiftMonthKey(month, 1))}
				>
					›
				</Button>
			</Inline>
		</label>
	</Cluster>
{/snippet}

{#snippet monthStatus()}
	<Stack gap="sm">
		<Cluster gap="sm">
			{#if rosters.length === 0}
				<Badge variant="outline">No roster drafted for {month}</Badge>
			{:else}
				{#each rosters as roster (roster.norbital_id)}
					<Inline gap="xs">
						<Badge variant={roster.published_at == null ? 'outline' : 'default'}>
							{roster.published_at == null ? 'Draft' : 'Published'}
						</Badge>
						{#if roster.published_at == null}
							<Button size="sm" disabled={publishing} onclick={() => publish(roster.norbital_id)}>
								Publish {month}
							</Button>
						{:else}
							<Button
								size="sm"
								variant="outline"
								disabled={publishing}
								onclick={() => reopen(roster.norbital_id)}
							>
								Re-open
							</Button>
						{/if}
					</Inline>
				{/each}
			{/if}
			{#each exceptions as exception (exception.status)}
				<Badge variant="destructive">
					{exception.count}
					{STATUS_PRESENTATION[exception.status].label.toLowerCase()}
				</Badge>
			{/each}
		</Cluster>
		<p class="text-sm text-muted-foreground">
			Publishing checks the month against the work pattern: at least one rest day in every week,
			plus any consecutive-day, daily-hours and between-shift limits the pattern promises. A
			published month is frozen, so re-open it before correcting a day.
		</p>
	</Stack>
{/snippet}

{#snippet board()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to load its roster.</p>
	{:else}
		<Stack gap="md">
			{@render monthStatus()}
			{#if loading}
				<p class="text-sm text-muted-foreground">Loading {month}…</p>
			{:else}
				<RosterMonthBoard {month} {people} {facts} {today} {cutoff} />
			{/if}
		</Stack>
	{/if}
{/snippet}

{#snippet personCalendar()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to load a calendar.</p>
	{:else if people.length === 0}
		<p class="text-sm text-muted-foreground">No active employments for this legal entity.</p>
	{:else}
		<Stack gap="md">
			<label class="grid max-w-md gap-1.5 text-sm">
				<span class="font-medium text-muted-foreground">Person</span>
				<Combobox
					ariaLabel="Person"
					options={personOptions}
					value={selectedPersonId}
					onValueChange={(value) => {
						personId = typeof value === 'string' ? value : (people[0]?.id ?? null);
					}}
					emptyPlaceholder="Select a person…"
					searchPlaceholder="Search people…"
				/>
			</label>
			{#if selectedPersonId != null}
				<RosterPersonCalendar {month} employmentId={selectedPersonId} {facts} {today} {cutoff} />
			{/if}
		</Stack>
	{/if}
{/snippet}

{#snippet patterns()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its work patterns.</p>
	{:else}
		<Stack gap="md">
			<p class="text-sm text-muted-foreground">
				A work pattern names which weekdays are working, rest and off, and which weekday the week
				starts on — so a week running Tuesday to Monday, or one that swaps its rest and off days, is
				stated rather than inferred. A rostered pattern derives nothing and takes every day from the
				published roster.
			</p>
			<CollectionTable
				{client}
				collection="work_patterns"
				view={`hr_controller:scheduling:patterns:${selectedCompanyId}`}
				query={{
					where: { company_id: { eq: selectedCompanyId } },
					orderBy: { code: 'asc' }
				}}
				searchPlaceholder="Search work patterns…"
			>
				{#snippet columns({ Column })}
					<Column name="code" card="title" />
					<Column name="name" card="subtitle" />
					<Column name="variant" label="Shape of the week" />
					<Column
						name="default_shift_definition_id"
						label="Default shift"
						render={({ value }) =>
							value == null || value === '' ? '—' : (shiftLabelsById.get(String(value)) ?? '—')}
					/>
					<Column name="min_rest_days_per_week" label="Min rest days/week" card="badge" />
					<Column name="max_consecutive_work_days" label="Max consecutive days" />
					<Column name="effective_range" label="Effective" />
				{/snippet}
			</CollectionTable>
		</Stack>
	{/if}
{/snippet}

{#snippet shifts()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its shifts.</p>
	{:else}
		<CollectionTable
			{client}
			collection="shift_definitions"
			view={`hr_controller:scheduling:shifts:${selectedCompanyId}`}
			query={{
				where: { company_id: { eq: selectedCompanyId }, ...activeRange },
				orderBy: { code: 'asc' }
			}}
			searchPlaceholder="Search shifts…"
		>
			{#snippet columns({ Column })}
				<Column name="code" card="title" />
				<Column name="name" card="subtitle" />
				<Column name="start_time" label="Start" />
				<Column name="end_time" label="End" />
				<Column name="break_minutes" label="Break (min)" />
				<Column name="pays_overtime" label="OT eligible" />
				<Column name="overtime_break_minutes" label="OT break (min)" />
				<Column name="crosses_midnight" label="Crosses midnight" />
				<Column name="effective_range" label="Effective" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet rosterRows()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its roster rows.</p>
	{:else}
		<CollectionTable
			{client}
			collection="roster_entries"
			view={`hr_controller:scheduling:roster:${selectedCompanyId}`}
			query={{
				where: { employment_id: { in: employmentIds } },
				orderBy: { work_date: 'desc' }
			}}
			searchPlaceholder="Search roster entries…"
			importPipelines={[
				{
					id: 'roster-workbook',
					label: 'Roster workbook',
					description: `Import planned assignments into the ${month} draft from the roster template — one row per person per day, on its "Roster" sheet.`,
					icon: 'lucide:calendar-plus',
					getDisabledReason: () => rosterImportBlocker,
					run: async () => {
						const rosterId = draftRoster?.norbital_id;
						if (rosterId == null) return;
						await runWorkbookImport({
							collectionName: 'roster_entries',
							recordLabel: 'roster rows',
							buildPayload: (grids) => rosterImportPayload(grids, rosterId)
						});
					}
				}
			]}
		>
			{#snippet columns({ Column })}
				<Column name="work_date" label="Work date" card="title" />
				<Column
					name="employment_id"
					label="Employment"
					card="subtitle"
					render={({ value }) =>
						value == null || value === ''
							? '—'
							: (people.find((person) => person.id === String(value))?.number ?? '—')}
				/>
				<Column
					name="shift_definition_id"
					label="Underlying shift"
					render={({ value }) =>
						value == null || value === '' ? '—' : (shiftLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="assignment_code" label="Roster code" />
				<Column name="designation" label="Day type" card="badge" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet holidays()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its holidays.</p>
	{:else}
		<CollectionTable
			{client}
			collection="company_holidays"
			view={`hr_controller:scheduling:holidays:${selectedCompanyId}`}
			query={{
				where: { company_id: { eq: selectedCompanyId } },
				orderBy: { date: 'desc' }
			}}
			searchPlaceholder="Search holidays…"
		>
			{#snippet columns({ Column })}
				<Column name="date" label="Date" card="title" />
				<Column name="name" card="subtitle" />
				<Column name="scope" label="Scope" render={({ value }) => formatHolidayScope(value)} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="HR Controller"
		title="Scheduling"
		description="The month as a calendar — planned shifts and actual attendance in the same cell, with leave, public holidays and the payroll cut-off marked. Publishing a month checks it against the statutory rest rules."
		actions={companyScopeActions}
	/>
{/snippet}

<Cover top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{ name: 'board', label: 'Month board', icon: 'lucide:calendar-range', content: board },
			{
				name: 'calendar',
				label: 'Calendar',
				icon: 'lucide:calendar-days',
				content: personCalendar
			},
			{ name: 'patterns', label: 'Work patterns', icon: 'lucide:calendar-cog', content: patterns },
			{ name: 'shifts', label: 'Shift definitions', icon: 'lucide:clock-4', content: shifts },
			{ name: 'rows', label: 'Roster rows', icon: 'lucide:table-2', content: rosterRows },
			{ name: 'holidays', label: 'Holidays', icon: 'lucide:party-popper', content: holidays }
		] satisfies TabConfig[]}
	/>
</Cover>
