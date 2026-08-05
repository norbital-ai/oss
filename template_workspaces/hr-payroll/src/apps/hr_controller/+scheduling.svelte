<script lang="ts">
	import { client } from '$pod/client';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Button, buttonVariants } from '@norbital-ai/ui/button';
	import { Badge } from '@norbital-ai/ui/badge';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Indicator } from '@norbital-ai/ui/indicator';
	import { Input } from '@norbital-ai/ui/input';
	import * as Popover from '@norbital-ai/ui/popover';
	import { Cluster, Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { toast } from 'svelte-sonner';
	import {
		formatCalendarDate,
		formatDurationHours,
		formatHolidayScope
	} from '../../lib/ui/display-formatters.js';
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
	import {
		STATUS_PRESENTATION,
		buildRosterMonth,
		holidayNamesByDate,
		monthDays,
		monthProgress,
		type DayStatus,
		type MonthDrafting
	} from '../../lib/ui/roster/roster-month.js';

	let companyId = $state<string | null>(null);
	let month = $state<string>(monthKey(todayKey()));
	let publishing = $state(false);
	let importing = $state(false);
	/** Board query state, kept in the shape `CollectionTable` uses: free-text search plus filters. */
	let personSearch = $state('');
	let statusFilter = $state<DayStatus | null>(null);
	let shiftFilter = $state<string | null>(null);

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

	/** Overlaid onto the board from the company calendar; never a mark stored on a roster entry. */
	const companyHolidays = $derived(holidaysQuery?.current ?? []);
	const holidayNames = $derived(holidayNamesByDate(companyHolidays));

	const facts = $derived(
		buildRosterMonth({
			month,
			employmentIds,
			rosterEntries: rosterEntriesQuery?.current ?? [],
			timeEntries: timeEntriesQuery?.current ?? [],
			leaveRequests: leaveQuery?.current ?? [],
			holidays: companyHolidays,
			shiftCodeById,
			leaveCodeById,
			cutoff
		})
	);

	/**
	 * The board's own query controls, in `CollectionTable`'s idiom rather than a bespoke filter bar:
	 * free-text search over the row header, plus conditions that all have to match.
	 *
	 * A condition selects *rows*, not cells — a board with the absent days blanked out would hide the
	 * very context that makes an absence readable, so a filter keeps every day of the people it
	 * matches and drops the people it does not.
	 */
	const DAY_STATUSES = Object.keys(STATUS_PRESENTATION) as DayStatus[];
	const statusOptions = DAY_STATUSES.map((status) => ({
		value: status,
		label: STATUS_PRESENTATION[status].label,
		search_term: STATUS_PRESENTATION[status].label
	}));
	const shiftOptions = $derived(
		(shiftsQuery?.current ?? []).map((shift) => ({
			value: shift.code,
			label: `${shift.code} · ${shift.name}`,
			search_term: `${shift.code} ${shift.name}`
		}))
	);
	const activeFilterCount = $derived(
		(statusFilter == null ? 0 : 1) + (shiftFilter == null ? 0 : 1)
	);
	const searchActive = $derived(personSearch.trim() !== '');
	const days = $derived(monthDays(month));
	const boardPeople = $derived(
		people.filter((person) => {
			const term = personSearch.trim().toLowerCase();
			if (term !== '' && !`${person.number} ${person.name}`.toLowerCase().includes(term)) {
				return false;
			}
			if (statusFilter == null && shiftFilter == null) return true;
			return days.some((date) => {
				const day = facts.get(`${person.id}:${date}`);
				if (day == null) return false;
				if (statusFilter != null && day.status !== statusFilter) return false;
				if (shiftFilter != null && day.shiftCode !== shiftFilter) return false;
				return true;
			});
		})
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
	/**
	 * How far the month has got, which is the difference between an empty board and a broken one.
	 *
	 * A month nobody has drafted has every person-day unrostered — three hundred people times
	 * thirty-one days — and that tally is what the month is *supposed* to look like before anyone has
	 * touched it. `monthProgress` therefore counts an unrostered day as an exception only once the
	 * month is published and claims to be complete.
	 */
	const drafting = $derived<MonthDrafting>(
		rosters.length === 0 ? 'NOT_DRAFTED' : draftRoster != null ? 'DRAFT' : 'PUBLISHED'
	);
	const progress = $derived(monthProgress(facts, drafting));
	const rosterImportBlocker = $derived(
		draftRoster != null
			? null
			: rosters.length === 0
				? `No roster is drafted for ${month}. Create the draft month first, then import into it.`
				: `Roster ${month} is published, so its entries are fixed. Re-open the month to import into it.`
	);

	async function importRoster(): Promise<void> {
		const rosterId = draftRoster?.norbital_id;
		if (rosterId == null) return;
		importing = true;
		try {
			// `runWorkbookImport` reports its own refusals: the pipeline answers with the rows the
			// company's records contradict, and that list is the whole message worth showing.
			await runWorkbookImport({
				collectionName: 'roster_entries',
				recordLabel: 'roster rows',
				buildPayload: (grids) => rosterImportPayload(grids, rosterId)
			});
		} finally {
			importing = false;
		}
	}

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
		content="Plan the monthly roster on a calendar, publish it against the statutory rules, and manage the shifts a day is worked on and the patterns a week is shaped by"
	/>
	<meta name="pod:icon" content="lucide:calendar-clock" />
</svelte:head>

{#snippet companyScopeActions()}
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
{/snippet}

{#snippet boardToolbar()}
	<Inline gap="xs" justify="between" class="min-w-0">
		<Inline gap="xs" shrink={false}>
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
		<Inline gap="xs" shrink={false}>
			<Popover.Root>
				<Popover.Trigger
					class={cn(
						buttonVariants({ variant: 'ghost', size: 'icon' }),
						searchActive && 'bg-accent'
					)}
					aria-label="Search people"
					aria-pressed={searchActive}
				>
					<IconWrapper name="lucide:search" class="size-4" />
				</Popover.Trigger>
				<Popover.Content align="end" class="w-[min(24rem,calc(100vw-1rem))] p-2">
					<Inline gap="sm">
						<Input
							type="search"
							class="h-9"
							placeholder="Search people…"
							bind:value={personSearch}
						/>
						{#if searchActive}
							<Button type="button" variant="ghost" size="sm" onclick={() => (personSearch = '')}>
								Clear
							</Button>
						{/if}
					</Inline>
				</Popover.Content>
			</Popover.Root>
			<Popover.Root>
				<Indicator visible={activeFilterCount > 0} variant="info" size="sm">
					<Popover.Trigger
						class={buttonVariants({ variant: 'ghost', size: 'icon' })}
						aria-label={activeFilterCount > 0 ? 'Filters active' : 'Filter the board'}
						aria-pressed={activeFilterCount > 0}
					>
						<IconWrapper name="lucide:list-filter" class="size-4" />
					</Popover.Trigger>
				</Indicator>
				<Popover.Content align="end" class="w-[min(22rem,calc(100vw-1rem))] p-0">
					<Inline justify="between" gap="sm" class="border-b px-3 py-2">
						<Stack gap="none">
							<p class="text-xs font-medium">Filters</p>
							<p class="text-micro text-muted-foreground">
								All conditions must match, and they keep whole people.
							</p>
						</Stack>
						{#if activeFilterCount > 0}
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onclick={() => {
									statusFilter = null;
									shiftFilter = null;
								}}
							>
								Clear all
							</Button>
						{/if}
					</Inline>
					<Stack gap="sm" class="p-3">
						<label class="grid gap-1.5 text-sm">
							<span class="font-medium text-muted-foreground">Has a day that is</span>
							<Combobox
								ariaLabel="Day status"
								options={statusOptions}
								value={statusFilter}
								allowClear
								searchable={false}
								emptyPlaceholder="Any status"
								onValueChange={(value) => {
									statusFilter = DAY_STATUSES.find((status) => status === value) ?? null;
								}}
							/>
						</label>
						<label class="grid gap-1.5 text-sm">
							<span class="font-medium text-muted-foreground">Rostered on shift</span>
							<Combobox
								ariaLabel="Shift"
								options={shiftOptions}
								value={shiftFilter}
								allowClear
								emptyPlaceholder="Any shift"
								searchPlaceholder="Search shifts…"
								onValueChange={(value) => {
									shiftFilter = typeof value === 'string' ? value : null;
								}}
							/>
						</label>
					</Stack>
				</Popover.Content>
			</Popover.Root>
			<Button
				size="sm"
				variant="outline"
				disabled={importing || rosterImportBlocker != null}
				title={rosterImportBlocker ??
					`Import planned assignments into the ${month} draft from the roster template — one row per person per day, on its "Roster" sheet.`}
				onclick={() => void importRoster()}
			>
				<IconWrapper name="lucide:upload" class="size-4" />
				Import
			</Button>
		</Inline>
	</Inline>
{/snippet}

{#snippet monthStatus()}
	<Stack gap="sm">
		<Cluster gap="sm">
			{#if progress.drafting === 'NOT_DRAFTED'}
				<Badge variant="outline">Not drafted for {month}</Badge>
				<Badge variant="outline">
					{progress.personDays.toLocaleString()} person-days to plan
				</Badge>
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
				{#if progress.drafting === 'DRAFT'}
					<!-- Progress, not a fault: a month is drafted a day at a time and is incomplete for most
					     of the time it is being written. -->
					<Badge variant="outline">
						{progress.rostered.toLocaleString()} of {progress.personDays.toLocaleString()} person-days
						drafted
					</Badge>
				{/if}
			{/if}
			{#each progress.exceptions as exception (exception.status)}
				<Badge variant="destructive">
					{exception.count.toLocaleString()}
					{STATUS_PRESENTATION[exception.status].label.toLowerCase()}
				</Badge>
			{/each}
		</Cluster>
		{#if progress.drafting === 'NOT_DRAFTED'}
			<p class="text-sm text-muted-foreground">
				Nothing has been planned for {month} yet, so every day on the board is blank. That is where a
				month starts, not a fault to fix: create the draft month, then assign or import its days.
			</p>
		{:else if rosterImportBlocker != null}
			<p class="text-sm text-muted-foreground">{rosterImportBlocker}</p>
		{/if}
		<p class="text-sm text-muted-foreground">
			Publishing checks the month against the work pattern: at least one rest day in every week,
			plus any consecutive-day, daily-hours and between-shift limits the pattern promises. A
			published month is frozen, so re-open it before correcting a day.
		</p>
	</Stack>
{/snippet}

{#snippet boardChrome()}
	<Stack gap="md">
		{@render boardToolbar()}
		{@render monthStatus()}
	</Stack>
{/snippet}

<!--
	The chrome is the `Cover`'s top row and the board is its body, which is what gives the board a
	definite height to fill: `Cover`'s middle track is `minmax(0,1fr)`. The board owns the scroll from
	there, so the tab panel around it never has to — the same division `CollectionTable` makes between
	its toolbar and its rows.
-->
{#snippet board()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to load its roster.</p>
	{:else}
		<Cover gap="md" top={boardChrome}>
			{#if loading}
				<p class="text-sm text-muted-foreground">Loading {month}…</p>
			{:else if people.length > 0 && boardPeople.length === 0}
				<p class="text-sm text-muted-foreground">No people match the current search or filters.</p>
			{:else}
				<RosterMonthBoard {month} people={boardPeople} {facts} {today} {holidayNames} {cutoff} />
			{/if}
		</Cover>
	{/if}
{/snippet}

{#snippet shifts()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its shifts.</p>
	{:else}
		<Stack gap="md">
			<p class="text-sm text-muted-foreground">
				A shift definition is one working <em>day</em>: when it starts, when it ends, the unpaid
				break inside it and whether it runs past midnight. It says nothing about which days of the
				week are worked — that is a work pattern, which arranges shifts into a week and names one of
				these as the day it uses.
			</p>
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
					<Column
						name="break_minutes"
						label="Break"
						render={({ value }) => formatDurationHours(value)}
					/>
					<Column name="pays_overtime" label="OT eligible" />
					<Column
						name="overtime_break_minutes"
						label="OT break"
						render={({ value }) => formatDurationHours(value)}
					/>
					<Column name="crosses_midnight" label="Crosses midnight" />
					<Column name="effective_range" label="Effective" />
				{/snippet}
			</CollectionTable>
		</Stack>
	{/if}
{/snippet}

{#snippet patterns()}
	{#if selectedCompanyId == null}
		<p class="text-sm text-muted-foreground">Select a legal entity to manage its work patterns.</p>
	{:else}
		<Stack gap="md">
			<p class="text-sm text-muted-foreground">
				A work pattern is one <em>week</em>: which weekdays are working, rest and off, which weekday
				the week starts on, and the scheduling limits a published roster must respect. It carries a
				default shift for its ordinary days rather than restating one — a rostered pattern derives
				nothing at all and takes every day from the published roster.
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
				<Column
					name="date"
					label="Date"
					card="title"
					render={({ value }) => formatCalendarDate(value)}
				/>
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
			{ name: 'shifts', label: 'Shift definitions', icon: 'lucide:clock-4', content: shifts },
			{ name: 'patterns', label: 'Work patterns', icon: 'lucide:calendar-cog', content: patterns },
			{ name: 'holidays', label: 'Holidays', icon: 'lucide:party-popper', content: holidays }
		] satisfies TabConfig[]}
	/>
</Cover>
