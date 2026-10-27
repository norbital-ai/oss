<!-- A bounded, server-filtered view of the environment's separate host audit store. -->
<script lang="ts">
	import {
		Button,
		Combobox,
		Icon,
		Input,
		Popover,
		StructuredData,
		Table,
		useKinds,
		type Kind
	} from '@norbital-ai/ui';
	import { fork, observeOnce } from '@norbital-ai/ui/effect';
	import { Effect, Result, Schema } from 'effect';
	import { Debounced } from 'runed';
	import { onDestroy, untrack } from 'svelte';
	import {
		AUDIT_ACTOR_KINDS,
		AUDIT_CATEGORIES,
		AUDIT_STATUSES,
		type AuditQuery,
		type AuditSummary
	} from '../../protocol/audit.ts';
	import type { ShellApi } from '../api-types.ts';
	import DetailSheet from '../DetailSheet.svelte';
	import SystemPage from '../SystemPage.svelte';
	import auditBanner from '../assets/banners/audit.jpg';
	import { displayWireValue } from '../wire-value.ts';

	let {
		api,
		admin,
		locale,
		t
	}: {
		api: Pick<ShellApi, 'audit' | 'auditDetail' | 'settings'>;
		admin: boolean;
		locale: string;
		t: (key: string) => string;
	} = $props();

	const kinds = useKinds();
	const WINDOWS = ['day', 'week', 'month', 'all', 'custom'] as const;
	const SIZES = [25, 50, 100, 200] as const;
	const initial = untrack(() =>
		typeof location === 'undefined' ? new URLSearchParams() : new URL(location.href).searchParams
	);
	const saved = (key: string) => initial.get(`audit.${key}`) ?? '';
	let text = $state(saved('text'));
	let window = $state<(typeof WINDOWS)[number]>(
		WINDOWS.find((v) => v === saved('window')) ?? 'week'
	);
	let since = $state(saved('since'));
	let until = $state(saved('until'));
	let category = $state<AuditQuery['category']>(
		AUDIT_CATEGORIES.find((v) => v === saved('category'))
	);
	let status = $state<AuditQuery['status']>(AUDIT_STATUSES.find((v) => v === saved('status')));
	let actorKind = $state<AuditQuery['actorKind']>(
		AUDIT_ACTOR_KINDS.find((v) => v === saved('actorKind'))
	);
	let actorId = $state(saved('actorId'));
	let action = $state(saved('action'));
	let model = $state(saved('model'));
	let record = $state(saved('record'));
	let invocation = $state(saved('invocation'));
	let run = $state(saved('run'));
	let order = $state<'newest' | 'oldest'>(saved('order') === 'oldest' ? 'oldest' : 'newest');
	let limit = $state<(typeof SIZES)[number]>(SIZES.find((v) => String(v) === saved('limit')) ?? 50);
	let anchor = $state(Date.now());
	let filtersOpen = $state(false);
	let selected = $state<AuditSummary | null>(null);
	let copied = $state(false);
	let copyError = $state<string | null>(null);
	const words = new Debounced(
		() => ({
			text: text.trim(),
			actorId: actorId.trim(),
			action: action.trim(),
			model: model.trim(),
			record: record.trim(),
			invocation: invocation.trim(),
			run: run.trim()
		}),
		300
	);
	onDestroy(words.cancel);
	const customError = $derived(
		window !== 'custom'
			? null
			: (since !== '' && !Number.isFinite(Date.parse(since))) ||
				  (until !== '' && !Number.isFinite(Date.parse(until)))
				? t('Enter a valid date and time.')
				: since !== '' && until !== '' && Date.parse(since) >= Date.parse(until)
					? t('The end must be later than the start.')
					: null
	);
	const range = $derived.by(() => {
		if (window === 'all') return {};
		if (window === 'custom')
			return customError !== null
				? {}
				: {
						...(since === '' ? {} : { since: new Date(since).toISOString() }),
						...(until === '' ? {} : { until: new Date(until).toISOString() })
					};
		const days = window === 'day' ? 1 : window === 'week' ? 7 : 30;
		return { since: new Date(anchor - days * 86_400_000).toISOString() };
	});
	const query = $derived<AuditQuery>({
		order,
		limit,
		...range,
		...(category === undefined ? {} : { category }),
		...(status === undefined ? {} : { status }),
		...(actorKind === undefined ? {} : { actorKind }),
		...Object.fromEntries(Object.entries(words.current).filter(([, value]) => value !== ''))
	});
	const filterKey = $derived(JSON.stringify(query));
	let cursor = $state<{
		key: string;
		after: string | null;
		back: readonly (string | null)[];
	} | null>(null);
	const position = $derived(
		cursor?.key === filterKey ? cursor : { key: filterKey, after: null, back: [] }
	);
	const request = $derived({
		key: JSON.stringify([filterKey, position.after]),
		query: { ...query, ...(position.after === null ? {} : { after: position.after }) }
	});
	const page = observeOnce(() => {
		const own = request;
		return !admin || customError !== null
			? null
			: api.audit(own.query).pipe(Effect.map((page) => ({ key: own.key, page })));
	});
	const answer = $derived(page.current?.key === request.key ? page.current.page : undefined);
	const opened = observeOnce(() => {
		const id = selected?.id;
		return !admin || id === undefined
			? null
			: api.auditDetail(id).pipe(Effect.map((record) => ({ id, record })));
	});
	const detail = $derived(opened.current?.id === selected?.id ? opened.current?.record : undefined);
	/** The workspace's people, so an actor reads as a person rather than a uuid (the sheet keeps the id). */
	const directory = observeOnce(() => (admin ? api.settings() : null));
	const names = $derived(
		new Map(
			(directory.current?.members ?? []).map((member) => [
				member.id,
				member.name || member.email || member.phone || actorName('member')
			])
		)
	);
	const nameOf = (actor: AuditSummary['actor']) =>
		actor.label ||
		(actor.kind === 'member'
			? (names.get(actor.id ?? '') ?? actorName('member'))
			: actorName(actor.kind));
	const error = $derived(customError ?? page.error?.message ?? null);
	const activeFilters = $derived(
		[
			actorKind,
			actorId.trim(),
			action.trim(),
			model.trim(),
			record.trim(),
			invocation.trim(),
			run.trim()
		].filter((value) => value !== undefined && value !== '').length
	);
	const statusName = (value: AuditSummary['status']) =>
		t(
			value === 'pendingApproval'
				? 'Pending approval'
				: value.charAt(0).toUpperCase() + value.slice(1)
		);
	const actorName = (value: AuditSummary['actor']['kind']) =>
		t(value === 'apiKey' ? 'API key' : value.charAt(0).toUpperCase() + value.slice(1));
	const when = (value: string) => new Date(value).toLocaleString(locale);
	/** A write's verb, as the event line reads it. */
	const VERBS: { readonly [verb: string]: string } = {
		create: 'Created',
		update: 'Updated',
		delete: 'Deleted',
		upsert: 'Upserted',
		merge: 'Merged',
		decide: 'Decided',
		start: 'Started',
		finish: 'Finished',
		remove: 'Removed',
		restore: 'Restored',
		erase: 'Erased'
	};
	const word = (value: string) => value.replaceAll(/[._]/g, ' ').replaceAll(/\s+/g, ' ').trim();
	/** `orders.update` reads as a sentence; an action without a verb (an automation, a decision) keeps its words. */
	const phrase = (action: string) => {
		const dot = action.lastIndexOf('.');
		const verb = VERBS[dot <= 0 ? action : action.slice(dot + 1)];
		if (verb === undefined)
			return word(action).replace(/^./, (character) => character.toUpperCase());
		return dot <= 0 ? t(verb) : t(`${verb} {what}`).replace('{what}', word(action.slice(0, dot)));
	};
	const rows = $derived(
		(answer?.rows ?? []).map((row) => ({
			id: row.id,
			at: row.at,
			action: row.action,
			event: phrase(row.action),
			category: row.category,
			status: row.status,
			actor: nameOf(row.actor),
			actorKind: actorName(row.actor.kind),
			what: row.subject === null ? '' : word(row.subject.model)
		}))
	);
	type AuditRow = (typeof rows)[number];
	/** A row's stored image: system columns are not a person's change. */
	const SYSTEM = new Set([
		'id',
		'revision',
		'created_at',
		'created_by',
		'updated_at',
		'updated_by',
		'bolt_search',
		'bolt_embedding'
	]);
	const Change = Schema.Struct({
		model: Schema.String,
		op: Schema.String,
		old: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
		new: Schema.NullOr(Schema.Record(Schema.String, Schema.Json))
	});
	const Payload = Schema.Struct({
		change: Schema.optionalKey(Change),
		records: Schema.optionalKey(Schema.Array(Change)),
		request: Schema.optionalKey(Schema.Json)
	});
	const Given = Schema.Struct({
		input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
	});
	type Change = typeof Change.Type;
	type Given = typeof Given.Type;
	/** Stored images stay typed so empty, null, missing and false values remain distinct in the shared diff. */
	const changed = (change: Change, given: Given | undefined) => {
		const declared = kinds.catalog?.[change.model]?.fields;
		const keep = (field: string) =>
			!SYSTEM.has(field) &&
			!declared?.[field]?.hidden &&
			(change.op !== 'create' || given?.input === undefined || Object.hasOwn(given.input, field));
		const before = Object.fromEntries(
			Object.entries(change.old ?? {})
				.filter(([field]) => keep(field))
				.map(([field, value]) => [field, displayWireValue(value)])
		);
		const after = Object.fromEntries(
			Object.entries(change.new ?? {})
				.filter(([field]) => keep(field))
				.map(([field, value]) => [field, displayWireValue(value)])
		);
		const kindOf = (field: string): Kind => declared?.[field] ?? { kind: 'json' };
		const fields = Object.fromEntries(
			[...new Set([...Object.keys(before), ...Object.keys(after)])].map((field) => [
				field,
				kindOf(field)
			])
		);
		const verb = VERBS[change.op] ?? word(change.op).replace(/^./, (c) => c.toUpperCase());
		return {
			heading: t(`${verb} {what}`).replace('{what}', word(change.model)),
			before,
			after,
			kind: { kind: 'object' as const, fields }
		};
	};
	const changes = $derived.by(() => {
		if (detail === undefined || detail === null) return [];
		const decoded = Result.match(Schema.decodeUnknownResult(Payload)(detail.payload), {
			onSuccess: (payload) => payload,
			onFailure: () => null
		});
		if (decoded === null) return [];
		const request = decoded.request;
		const given = Result.match(
			Schema.decodeUnknownResult(Given)(
				typeof request === 'object' && request !== null && !Array.isArray(request) ? request : null
			),
			{ onSuccess: (value) => value, onFailure: () => undefined }
		);
		const list = [
			...(decoded.change === undefined ? [] : [decoded.change]),
			...(decoded.records ?? [])
		];
		// the submitted input only maps one record; a cascade's rows show their stored images
		return list.map((change) => changed(change, list.length === 1 ? given : undefined));
	});
	const choose = (row: AuditRow) => {
		selected = answer?.rows.find((item) => item.id === row.id) ?? null;
		copied = false;
		copyError = null;
	};
	const previous = () => {
		cursor = {
			key: filterKey,
			after: position.back.at(-1) ?? null,
			back: position.back.slice(0, -1)
		};
	};
	const next = () => {
		if (answer?.next !== null && answer?.next !== undefined)
			cursor = { key: filterKey, after: answer.next, back: [...position.back, position.after] };
	};
	const refresh = () => {
		anchor = Date.now();
		cursor = null;
		fork(page.refetch());
	};
	const clear = () => {
		text = actorId = action = model = record = invocation = run = '';
		category = status = actorKind = undefined;
	};
	const copy = Effect.fn('Audit.copy')(function* () {
		if (detail === null || detail === undefined) return;
		copyError = null;
		const result = yield* Effect.result(
			Effect.tryPromise(() => navigator.clipboard.writeText(JSON.stringify(detail, null, 2)))
		);
		if (result._tag === 'Success') copied = true;
		else copyError = t('Could not copy. Select and copy the payload below.');
	});

	$effect(() => {
		const values = {
			...words.current,
			window,
			since: window === 'custom' ? since : '',
			until: window === 'custom' ? until : '',
			category: category ?? '',
			status: status ?? '',
			actorKind: actorKind ?? '',
			order,
			limit: String(limit)
		};
		if (typeof location === 'undefined') return;
		const url = new URL(location.href);
		for (const [key, value] of Object.entries(values)) {
			if (value === '') url.searchParams.delete(`audit.${key}`);
			else url.searchParams.set(`audit.${key}`, value);
		}
		if (url.href !== location.href) history.replaceState(history.state, '', url);
	});
</script>

{#snippet at({ row }: { row: AuditRow })}
	<time datetime={row.at} title={when(row.at)} class="tabular-nums">{when(row.at)}</time>
{/snippet}
{#snippet event({ row }: { row: AuditRow })}
	<span class="flex min-w-0 flex-col gap-0.5">
		<span class="truncate font-medium" title={row.action}>{row.event}</span>
		<span class="text-meta">{t(row.category)}</span>
	</span>
{/snippet}
{#snippet what({ row }: { row: AuditRow })}
	<span class="truncate">{row.what === '' ? '—' : row.what}</span>
{/snippet}
{#snippet state({ row }: { row: AuditRow })}
	<span
		data-audit-status={row.status}
		class={['refused', 'failed', 'conflict'].includes(row.status)
			? 'text-destructive'
			: 'text-muted-foreground'}>{statusName(row.status)}</span
	>
{/snippet}
{#snippet actor({ row }: { row: AuditRow })}
	<span class="flex min-w-0 flex-col gap-0.5">
		<span class="truncate">{row.actor}</span>
		{#if row.actor !== row.actorKind}<span class="text-meta">{row.actorKind}</span>{/if}
	</span>
{/snippet}
{#snippet empty()}
	<div class="flex flex-col items-center gap-1 px-4 py-12 text-center" aria-live="polite">
		<p class="text-sm font-medium">
			{page.loading
				? t('Loading audit events…')
				: error !== null
					? t('Audit events could not be loaded')
					: t('No events match these filters')}
		</p>
		{#if !page.loading && error === null}<p class="text-meta">
				{t('Try a wider date range or clear a filter.')}
			</p>{/if}
	</div>
{/snippet}
{#snippet pager()}
	<div class="flex w-full flex-wrap items-center justify-between gap-2" data-audit-pager>
		<span class="px-1 tabular-nums" aria-live="polite">
			{page.loading
				? t('Loading…')
				: error !== null
					? t('Events unavailable')
					: t('{n} events · Page {page}')
							.replace('{n}', String(rows.length))
							.replace('{page}', String(position.back.length + 1))}
		</span>
		<div class="flex items-center gap-1">
			<Combobox
				size="sm"
				variant="ghost"
				class="w-28"
				searchable={false}
				aria-label={t('Events per page')}
				options={SIZES.map((n) => ({
					value: String(n),
					label: t('{n} / page').replace('{n}', String(n))
				}))}
				value={String(limit)}
				onChange={(value) => {
					limit = SIZES.find((n) => String(n) === value) ?? 50;
				}}
			/>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label={t('Previous page')}
				hint={t('Previous page')}
				disabled={page.loading || position.back.length === 0}
				onclick={previous}
			>
				<Icon name="lucide:chevron-left" class="size-4" />
			</Button>
			<Button
				size="icon-sm"
				variant="ghost"
				aria-label={t('Next page')}
				hint={t('Next page')}
				disabled={page.loading || answer === undefined || answer.next === null}
				onclick={next}
			>
				<Icon name="lucide:chevron-right" class="size-4" />
			</Button>
		</div>
	</div>
{/snippet}

<SystemPage
	name="settings-audit"
	title={t('Audit trail')}
	icon="lucide:scroll-text"
	banner={auditBanner}
	description={t(
		'Workspace activity, decisions, and outcomes. Open an event to inspect its full payload.'
	)}
	error={admin ? error : t('Administrator access required.')}
>
	{#if admin}
		<div class="flex flex-col gap-2" data-audit-toolbar>
			<div class="flex flex-wrap items-center gap-2">
				<label class="relative min-w-44 flex-1 basis-56">
					<span class="sr-only">{t('Search audit events and payloads')}</span>
					<Icon
						name="lucide:search"
						class="pointer-events-none absolute top-1/2 left-2.5 z-10 size-4 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						type="search"
						bind:value={text}
						class="pl-8"
						placeholder={t('Search events and payloads…')}
					/>
				</label>
				<Combobox
					size="sm"
					class="w-36"
					searchable={false}
					aria-label={t('Date range')}
					options={[
						{ value: 'day', label: t('Last 24 hours') },
						{ value: 'week', label: t('Last 7 days') },
						{ value: 'month', label: t('Last 30 days') },
						{ value: 'all', label: t('All time') },
						{ value: 'custom', label: t('Custom dates') }
					]}
					value={window}
					onChange={(value) => {
						window = WINDOWS.find((v) => v === value) ?? 'week';
					}}
				/>
				<Combobox
					size="sm"
					class="w-36"
					searchable={false}
					clearable
					placeholder={t('All categories')}
					aria-label={t('Category')}
					options={AUDIT_CATEGORIES.map((value) => ({ value, label: t(value) }))}
					value={category ?? null}
					onChange={(value) => {
						category = value ?? undefined;
					}}
				/>
				<Combobox
					size="sm"
					class="w-36"
					searchable={false}
					clearable
					placeholder={t('All statuses')}
					aria-label={t('Status')}
					options={AUDIT_STATUSES.map((value) => ({ value, label: statusName(value) }))}
					value={status ?? null}
					onChange={(value) => {
						status = value ?? undefined;
					}}
				/>
				<Popover.Root bind:open={filtersOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="sm" variant="outline" data-audit-filters>
								<Icon name="lucide:list-filter" class="size-4" />{t('Filters')}{activeFilters > 0
									? ` (${activeFilters})`
									: ''}
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content
						align="end"
						class="max-h-[80dvh] w-[min(25rem,calc(100vw-1rem))] overflow-y-auto p-4"
					>
						<div class="flex flex-col gap-3">
							<p class="text-sm font-medium">{t('Filter audit events')}</p>
							<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
								<label class="flex flex-col gap-1 text-xs"
									>{t('Actor type')}
									<Combobox
										size="sm"
										searchable={false}
										clearable
										placeholder={t('All actors')}
										options={AUDIT_ACTOR_KINDS.map((value) => ({ value, label: actorName(value) }))}
										value={actorKind ?? null}
										onChange={(value) => {
											actorKind = value ?? undefined;
										}}
									/>
								</label>
								<label class="flex flex-col gap-1 text-xs"
									>{t('Actor ID')}<Input bind:value={actorId} /></label
								>
								<label class="flex flex-col gap-1 text-xs sm:col-span-2"
									>{t('Action')}<Input bind:value={action} placeholder="orders.update" /></label
								>
								<label class="flex flex-col gap-1 text-xs"
									>{t('Model')}<Input bind:value={model} /></label
								>
								<label class="flex flex-col gap-1 text-xs"
									>{t('Record ID')}<Input bind:value={record} /></label
								>
								<label class="flex flex-col gap-1 text-xs"
									>{t('Invocation ID')}<Input bind:value={invocation} /></label
								>
								<label class="flex flex-col gap-1 text-xs"
									>{t('Run ID')}<Input bind:value={run} /></label
								>
							</div>
							<Button size="sm" variant="ghost" class="self-start" onclick={clear}
								>{t('Clear filters and search')}</Button
							>
						</div>
					</Popover.Content>
				</Popover.Root>
				<Combobox
					size="sm"
					variant="ghost"
					class="w-32"
					searchable={false}
					aria-label={t('Time order')}
					options={[
						{ value: 'newest', label: t('Newest first') },
						{ value: 'oldest', label: t('Oldest first') }
					]}
					value={order}
					onChange={(value) => {
						order = value === 'oldest' ? 'oldest' : 'newest';
					}}
				/>
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label={t('Refresh audit events')}
					hint={t('Refresh audit events')}
					disabled={page.loading || customError !== null}
					onclick={refresh}
					data-audit-refresh
				>
					<Icon name="lucide:refresh-cw" class="size-4" />
				</Button>
			</div>
			{#if window === 'custom'}
				<div class="flex flex-wrap items-end gap-2">
					<label class="flex flex-col gap-1 text-xs"
						>{t('From')}<Input
							type="datetime-local"
							bind:value={since}
							aria-invalid={customError !== null}
						/></label
					>
					<label class="flex flex-col gap-1 text-xs"
						>{t('Until')}<Input
							type="datetime-local"
							bind:value={until}
							aria-invalid={customError !== null}
						/></label
					>
					<span class="pb-2 text-xs text-muted-foreground"
						>{t('Dates use your local time zone.')}</span
					>
				</div>
			{/if}
		</div>
		<div class="flex min-h-64 min-w-0 flex-1 flex-col" aria-busy={page.loading} data-audit-table>
			<Table
				of={rows}
				key="audit-events"
				toolbar={false}
				controlled
				{empty}
				footer={pager}
				columns={[
					{ field: 'event', label: t('Event'), cell: event, width: 260 },
					{ field: 'at', label: t('When'), cell: at, width: 190 },
					{ field: 'what', label: t('What'), cell: what, width: 200 },
					{ field: 'actor', label: t('Who'), cell: actor, width: 220 },
					{ field: 'status', label: t('Outcome'), cell: state, width: 140 }
				]}
				onOpen={choose}
			/>
		</div>
	{/if}
</SystemPage>

{#if admin && selected !== null}
	<DetailSheet
		title={phrase(selected.action)}
		onClose={() => {
			selected = null;
		}}
		fields={[
			{ label: t('When'), value: when(selected.at) },
			{ label: t('Outcome'), value: statusName(selected.status) },
			{ label: t('Who'), value: `${nameOf(selected.actor)} (${actorName(selected.actor.kind)})` },
			{ label: t('What'), value: selected.subject?.model },
			{ label: t('Category'), value: t(selected.category) },
			{ label: t('Recorded'), value: when(selected.recordedAt) }
		]}
	>
		<section class="flex min-w-0 flex-col gap-3" aria-label={t('Changes')}>
			<h2 class="text-sm font-medium">{t('Changes')}</h2>
			{#if opened.error}<p role="alert" class="text-sm text-destructive">{opened.error.message}</p>
				<Button
					size="sm"
					variant="outline"
					class="self-start"
					onclick={() => fork(opened.refetch())}>{t('Retry')}</Button
				>
			{:else if detail === undefined}<p role="status" class="text-meta">{t('Loading changes…')}</p>
			{:else if detail === null}<p role="status" class="text-meta">
					{t('This audit event is no longer available.')}
				</p>
			{:else if changes.length === 0}<p role="status" class="text-meta">
					{t('No field changes were recorded for this event.')}
				</p>
			{:else}
				{#each changes as change}
					<div class="flex min-w-0 flex-col gap-1" data-audit-change>
						<p class="text-sm font-medium">{change.heading}</p>
						{#if Object.keys(change.before).length === 0 && Object.keys(change.after).length === 0}<p
								class="text-meta"
							>
								{t('No field changes were recorded for this event.')}
							</p>
						{:else}
							<StructuredData
								before={change.before}
								kind={change.kind}
								value={change.after}
								mode="diff"
								changesOnly
								name={change.heading}
							/>
						{/if}
					</div>
				{/each}
			{/if}
			{#if detail !== null && detail !== undefined}
				<details class="rounded-md border bg-muted/20 px-3 py-2" data-audit-raw>
					<summary class="cursor-pointer text-xs font-medium"
						>{t('Event details and payload')}</summary
					>
					<div class="mt-2 flex flex-col gap-2">
						<dl class="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
							{#each [{ label: t('Event ID'), value: selected.id }, { label: t('Operation ID'), value: selected.operationId }, { label: t('Invocation ID'), value: selected.invocation }, { label: t('Transaction ID'), value: selected.transaction }, { label: t('Run ID'), value: selected.run }, { label: t('Approval ID'), value: selected.approval }, { label: t('Record ID'), value: selected.subject?.id }, { label: t('Revision'), value: selected.subject?.revision }, { label: t('Payload bytes'), value: selected.payloadBytes }] as entry (entry.label)}
								{#if entry.value !== undefined && entry.value !== null}
									<div class="flex min-w-0 gap-2">
										<dt class="shrink-0 text-meta">{entry.label}</dt>
										<dd class="min-w-0 wrap-anywhere font-mono">{entry.value}</dd>
									</div>
								{/if}
							{/each}
						</dl>
						<div class="flex items-center justify-between gap-2">
							<span class="text-meta">{t('Payload')}</span>
							<Button size="sm" variant="outline" onclick={() => fork(copy())}>
								<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="size-3.5" />{copied
									? t('Copied')
									: t('Copy event JSON')}
							</Button>
						</div>
						<div aria-label={t('Full event payload')} class="max-h-[50dvh] overflow-auto">
							<StructuredData value={detail.payload} name={t('Payload')} />
						</div>
					</div>
				</details>
			{/if}
			{#if copyError !== null}<p role="alert" class="text-xs text-destructive">{copyError}</p>{/if}
		</section>
	</DetailSheet>
{/if}
