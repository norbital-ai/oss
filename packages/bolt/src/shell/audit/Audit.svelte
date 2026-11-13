<!-- The command center's audit trail: a bounded, server-filtered view of the environment's separate host audit store, read
once (Refresh, or the opt-in Auto-refresh). A phone's toolbar is search and Filters, whose Dialog holds every filter; Refresh
sits under the table there. -->
<script lang="ts">
	import {
		Badge,
		Button,
		Combobox,
		Dialog,
		Icon,
		Input,
		Popover,
		StructuredData,
		Table,
		ToolbarSearch,
		type Kind,
		type ModelExposure,
		type UiContext
	} from '@norbital-ai/ui';
	import { Cluster, Scroll } from '@norbital-ai/ui/layout';
	import { fork, observe_once } from '@norbital-ai/ui/effect';
	import { Effect, Result, Schema } from 'effect';
	import { Debounced, watch } from 'runed';
	import { onDestroy, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import {
		AUDIT_ACTOR_KINDS,
		AUDIT_CATEGORIES,
		AUDIT_STATUSES,
		type AuditQuery,
		type AuditSummary
	} from '../../protocol/audit.ts';
	import type { ShellApi } from '../api-types.ts';
	import AutoRefresh from '../AutoRefresh.svelte';
	import DetailSheet from '../DetailSheet.svelte';
	import { date_time } from '../i18n.ts';

	let {
		ctx,
		api,
		admin,
		locale,
		catalog,
		t
	}: {
		ctx: UiContext;
		api: Pick<ShellApi, 'audit' | 'audit_detail' | 'settings'>;
		admin: boolean;
		locale: string;
		catalog: Readonly<Record<string, ModelExposure>>;
		t: (key: string) => string;
	} = $props();

	const narrow = new MediaQuery('max-width: 47.999rem');
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
	let actor_kind = $state<AuditQuery['actor_kind']>(
		AUDIT_ACTOR_KINDS.find((v) => v === saved('actor_kind'))
	);
	let actor_id = $state(saved('actor_id'));
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
			actor_id: actor_id.trim(),
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
		...(actor_kind === undefined ? {} : { actor_kind }),
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
	// read by key: the debounced words settle into an equal new object, which must not read the page again
	const requestKey = $derived(request.key);
	const page = observe_once(() => {
		const key = requestKey;
		const query = untrack(() => request.query);
		return !admin || customError !== null
			? null
			: api.audit(query).pipe(Effect.map((page) => ({ key, page })));
	});
	const answer = $derived(page.current?.key === request.key ? page.current.page : undefined);
	const opened = observe_once(() => {
		const id = selected?.id;
		return !admin || id === undefined
			? null
			: api.audit_detail(id).pipe(Effect.map((record) => ({ id, record })));
	});
	const detail = $derived(opened.current?.id === selected?.id ? opened.current?.record : undefined);
	/** The workspace's people, so an actor reads as a person rather than a uuid (the sheet keeps the id). */
	const directory = observe_once(() => (admin ? api.settings() : null));
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
			// a phone's Filters holds these too; anywhere else they show in the toolbar
			...(narrow.current ? [category, status] : []),
			actor_kind,
			actor_id.trim(),
			action.trim(),
			model.trim(),
			record.trim(),
			invocation.trim(),
			run.trim()
		].filter((value) => value !== undefined && value !== '').length
	);
	const statusName = (value: AuditSummary['status']) =>
		t(
			value === 'pending_approval'
				? 'Pending approval'
				: value.charAt(0).toUpperCase() + value.slice(1)
		);
	const actorName = (value: AuditSummary['actor']['kind']) =>
		t(value === 'api_key' ? 'API key' : value.charAt(0).toUpperCase() + value.slice(1));
	const when = (value: string) => date_time(value, locale);
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
	/** A row event's record model; an operation's own events (prepared, settled) name the model or automation their action
	 * leads with (`orders.update`, `bolt.notify.finish`). */
	const whatOf = (e: Pick<AuditSummary, 'subject' | 'action'>) =>
		e.subject !== null
			? word(e.subject.model)
			: e.action.includes('.')
				? word(e.action.slice(0, e.action.lastIndexOf('.')))
				: '';
	const rows = $derived(
		(answer?.rows ?? []).map((row) => ({
			id: row.id,
			at: row.at,
			action: row.action,
			event: phrase(row.action),
			category: row.category,
			status: row.status,
			actor: nameOf(row.actor),
			actor_kind: actorName(row.actor.kind),
			what: whatOf(row)
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
		const declared = catalog[change.model]?.fields;
		const keep = (field: string) =>
			!SYSTEM.has(field) &&
			!declared?.[field]?.hidden &&
			(change.op !== 'create' || given?.input === undefined || Object.hasOwn(given.input, field));
		const before = Object.fromEntries(
			Object.entries(change.old ?? {})
				.filter(([field]) => keep(field))
				.map(([field, value]) => [field, value])
		);
		const after = Object.fromEntries(
			Object.entries(change.new ?? {})
				.filter(([field]) => keep(field))
				.map(([field, value]) => [field, value])
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
		const given = Result.match(Schema.decodeUnknownResult(Given)(decoded.request), {
			onSuccess: (value) => value,
			onFailure: () => undefined
		});
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
		text = actor_id = action = model = record = invocation = run = '';
		category = status = actor_kind = undefined;
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

	watch(
		() => ({
			...words.current,
			window,
			since: window === 'custom' ? since : '',
			until: window === 'custom' ? until : '',
			category: category ?? '',
			status: status ?? '',
			actor_kind: actor_kind ?? '',
			order,
			limit: String(limit)
		}),
		(values) => {
			if (typeof location === 'undefined') return;
			const url = new URL(location.href);
			for (const [key, value] of Object.entries(values)) {
				if (value === '') url.searchParams.delete(`audit.${key}`);
				else url.searchParams.set(`audit.${key}`, value);
			}
			if (url.href !== location.href) history.replaceState(history.state, '', url);
		}
	);
</script>

{#snippet at({ row }: { row: AuditRow })}
	<time datetime={row.at} title={when(row.at)} class="tabular-nums">{when(row.at)}</time>
{/snippet}
{#snippet event({ row }: { row: AuditRow })}
	<span class="flex min-w-0 items-center gap-2">
		<span class="truncate font-medium" title={row.action}>{row.event}</span>
		<Badge variant="outline" class="shrink-0" data-audit-category={row.category}
			>{t(row.category)}</Badge
		>
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
	<span class="flex min-w-0 items-baseline gap-1.5" title={`${row.actor} (${row.actor_kind})`}>
		<span class="truncate">{row.actor}</span>
		{#if row.actor !== row.actor_kind}<span class="shrink-0 text-meta">{row.actor_kind}</span>{/if}
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
{#snippet scope()}
	<Combobox
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
		on_change={(value) => {
			window = WINDOWS.find((v) => v === value) ?? 'week';
		}}
	/>
	<Combobox
		class="w-36"
		searchable={false}
		clearable
		placeholder={t('All categories')}
		aria-label={t('Category')}
		options={AUDIT_CATEGORIES.map((value) => ({ value, label: t(value) }))}
		value={category ?? null}
		on_change={(value) => {
			category = value ?? undefined;
		}}
	/>
	<Combobox
		class="w-36"
		searchable={false}
		clearable
		placeholder={t('All statuses')}
		aria-label={t('Status')}
		options={AUDIT_STATUSES.map((value) => ({ value, label: statusName(value) }))}
		value={status ?? null}
		on_change={(value) => {
			status = value ?? undefined;
		}}
	/>
{/snippet}
{#snippet ordering()}
	<Combobox
		variant="ghost"
		class="w-32"
		searchable={false}
		aria-label={t('Time order')}
		options={[
			{ value: 'newest', label: t('Newest first') },
			{ value: 'oldest', label: t('Oldest first') }
		]}
		value={order}
		on_change={(value) => {
			order = value === 'oldest' ? 'oldest' : 'newest';
		}}
	/>
{/snippet}
{#snippet reload()}
	<AutoRefresh {t} on_refresh={refresh} />
	<Button
		size="icon"
		variant="ghost"
		aria-label={t('Refresh audit events')}
		hint={t('Refresh audit events')}
		disabled={page.loading || customError !== null}
		onclick={refresh}
		data-audit-refresh
	>
		<Icon name="lucide:refresh-cw" class="size-4" />
	</Button>
{/snippet}
{#snippet filterFields()}
	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
		<label class="flex flex-col gap-1 text-xs"
			>{t('Actor type')}
			<Combobox
				searchable={false}
				clearable
				placeholder={t('All actors')}
				options={AUDIT_ACTOR_KINDS.map((value) => ({ value, label: actorName(value) }))}
				value={actor_kind ?? null}
				on_change={(value) => {
					actor_kind = value ?? undefined;
				}}
			/>
		</label>
		<label class="flex flex-col gap-1 text-xs">{t('Actor ID')}<Input bind:value={actor_id} /></label>
		<label class="flex flex-col gap-1 text-xs sm:col-span-2"
			>{t('Action')}<Input bind:value={action} placeholder="orders.update" /></label
		>
		<label class="flex flex-col gap-1 text-xs">{t('Model')}<Input bind:value={model} /></label>
		<label class="flex flex-col gap-1 text-xs">{t('Record ID')}<Input bind:value={record} /></label>
		<label class="flex flex-col gap-1 text-xs"
			>{t('Invocation ID')}<Input bind:value={invocation} /></label
		>
		<label class="flex flex-col gap-1 text-xs">{t('Run ID')}<Input bind:value={run} /></label>
	</div>
	<Button variant="ghost" class="self-start" onclick={clear}>{t('Clear filters and search')}</Button
	>
{/snippet}
{#snippet filtersButton({ props }: { props: Record<string, unknown> })}
	<Button {...props} variant="outline" data-audit-filters>
		<Icon name="lucide:list-filter" class="size-4" />{t('Filters')}{activeFilters > 0
			? ` (${activeFilters})`
			: ''}
	</Button>
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
				variant="ghost"
				class="w-28"
				searchable={false}
				aria-label={t('Events per page')}
				options={SIZES.map((n) => ({
					value: String(n),
					label: t('{n} / page').replace('{n}', String(n))
				}))}
				value={String(limit)}
				on_change={(value) => {
					limit = SIZES.find((n) => String(n) === value) ?? 50;
				}}
			/>
			<Button
				size="icon"
				variant="ghost"
				aria-label={t('Previous page')}
				hint={t('Previous page')}
				disabled={page.loading || position.back.length === 0}
				onclick={previous}
			>
				<Icon name="lucide:chevron-left" class="size-4" />
			</Button>
			<Button
				size="icon"
				variant="ghost"
				aria-label={t('Next page')}
				hint={t('Next page')}
				disabled={page.loading || answer === undefined || answer.next === null}
				onclick={next}
			>
				<Icon name="lucide:chevron-right" class="size-4" />
			</Button>
		</div>
		<!-- a phone's Refresh: here, Auto-refresh outlives the Filters dialog -->
		{#if narrow.current}<Cluster gap="xs">{@render reload()}</Cluster>{/if}
	</div>
{/snippet}

<div class="flex flex-col gap-3">
	{#if (admin ? error : t('Administrator access required.')) !== null}<p
			role="alert"
			class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
		>
			{admin ? error : t('Administrator access required.')}
		</p>{/if}
	{#if admin}
		<div class="flex flex-col gap-2" data-audit-toolbar>
			<Cluster>
				<ToolbarSearch bind:value={text} label={t('Search audit events and payloads')} />
				{#if narrow.current}
					<Dialog.Root bind:open={filtersOpen}>
						<Dialog.Trigger child={filtersButton} />
						<Dialog.Content>
							<Dialog.Header>
								<Dialog.Title>{t('Filter audit events')}</Dialog.Title>
							</Dialog.Header>
							<Scroll name={t('Filter audit events')} max="tall" layout="stack" gap="md">
								<Cluster>{@render scope()}{@render ordering()}</Cluster>
								{@render filterFields()}
							</Scroll>
						</Dialog.Content>
					</Dialog.Root>
				{:else}
					{@render scope()}
					<Popover.Root bind:open={filtersOpen}>
						<Popover.Trigger child={filtersButton} />
						<Popover.Content
							align="end"
							class="max-h-[80dvh] w-[min(25rem,calc(100vw-1rem))] overflow-y-auto p-4"
						>
							<div class="flex flex-col gap-3">
								<p class="text-sm font-medium">{t('Filter audit events')}</p>
								{@render filterFields()}
							</div>
						</Popover.Content>
					</Popover.Root>
					{@render ordering()}
					{@render reload()}
				{/if}
			</Cluster>
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
			<Table {ctx}
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
				on_open={choose}
			/>
		</div>
	{/if}
</div>

{#if admin && selected !== null}
	<DetailSheet {ctx}
		title={phrase(selected.action)}
		on_close={() => {
			selected = null;
		}}
		fields={[
			{ label: t('When'), value: when(selected.at) },
			{ label: t('Outcome'), value: statusName(selected.status) },
			{ label: t('Who'), value: `${nameOf(selected.actor)} (${actorName(selected.actor.kind)})` },
			{ label: t('What'), value: whatOf(selected) || undefined },
			{ label: t('Category'), value: t(selected.category) },
			{ label: t('Recorded'), value: when(selected.recorded_at) }
		]}
	>
		<section class="flex min-w-0 flex-col gap-3" aria-label={t('Changes')}>
			<h2 class="text-sm font-medium">{t('Changes')}</h2>
			{#if opened.error}<p role="alert" class="text-sm text-destructive">{opened.error.message}</p>
				<Button variant="outline" class="self-start" onclick={() => fork(opened.refetch())}
					>{t('Retry')}</Button
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
							<StructuredData {ctx}
								before={change.before}
								kind={change.kind}
								value={change.after}
								mode="diff"
								changes_only
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
							{#each [{ label: t('Event ID'), value: selected.id }, { label: t('Operation ID'), value: selected.operation_id }, { label: t('Invocation ID'), value: selected.invocation }, { label: t('Transaction ID'), value: selected.transaction }, { label: t('Run ID'), value: selected.run }, { label: t('Approval ID'), value: selected.approval }, { label: t('Record ID'), value: selected.subject?.id }, { label: t('Revision'), value: selected.subject?.revision }, { label: t('Payload bytes'), value: selected.payload_bytes }] as entry (entry.label)}
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
							<Button variant="outline" onclick={() => fork(copy())}>
								<Icon name={copied ? 'lucide:check' : 'lucide:copy'} class="size-3.5" />{copied
									? t('Copied')
									: t('Copy event JSON')}
							</Button>
						</div>
						<div aria-label={t('Full event payload')} class="max-h-[50dvh] overflow-auto">
							<StructuredData {ctx} value={detail.payload} name={t('Payload')} />
						</div>
					</div>
				</details>
			{/if}
			{#if copyError !== null}<p role="alert" class="text-xs text-destructive">{copyError}</p>{/if}
		</section>
	</DetailSheet>
{/if}
