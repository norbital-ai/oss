<!--
@component
The record header's history trigger opens a vertical timeline of revisions. A valid revision opens in the record's own
representation; an invalid one (its schema or values no longer fit) shows its captured data instead. The current
revision returns to the live record.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { ApprovalView, UiContext } from '../client/contract.js';
	import { historyStatus, moveText } from '../approval/row.js';
	import { recordText } from '../kinds/kind.js';
	import { Effect } from 'effect';
	import { observe_once } from '../effect/index.js';
	import { format } from '../kinds/kind.js';
	import type { RecordHistoryConfig } from './history.js';
	import { bolt_of } from '../client/context.js';
	import * as Popover from '../primitives/popover/index.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import Timeline from '../timeline/Timeline.svelte';
	import { revisionAction, type TimelineEntry } from '../timeline/timeline.js';
	import { checkpoints, type Checkpoint } from './history.js';
	import { by_id, first_of, page_of, READ_LIMIT, request_json } from '../read/request.js';
	import { label, msg, catalogText } from '../text/messages.js';
	import { label_read } from '../relations/select.js';

	let {
		ctx,
		of,
		latest,
		viewing,
		history,
		config = {},
		approvals = [],
		onload,
		onpick
	}: {
		ctx: UiContext;
		/** The record's approval requests: their decisions join the timeline (a request for changes writes no revision). */
		approvals?: readonly ApprovalView[];
		of: string;
		config?: RecordHistoryConfig;
		/** The live record's revision. */
		latest: number;
		/** The revision shown in the body; `null` is the live record. */
		viewing: number | null;
		/** The revisions' details, read on first opening (`onload`); `null` until then. */
		history: Effect.Effect<readonly Checkpoint[], Error> | null;
		onload: () => void;
		/** A revision to show and the instant it was written (`null` while history is unloaded); `null` (or `latest`)
		 * returns to the live record. */
		onpick: (revision: number | null, at: string | null) => void;
	} = $props();
	const bolt = $derived(bolt_of(ctx));
	const kinds = $derived(ctx.ui.kinds);
	const clock = untrack(() => bolt.clock('minute'));
	const relative = $derived(new Intl.RelativeTimeFormat(bolt.locale, { numeric: 'auto' }));
	const stamp = (at: Checkpoint['at']) =>
		format({ kind: 'instant' }, at, { locale: bolt.locale, zone: kinds.zone });
	/** How long before the page's current instant a revision was written, in its largest whole unit. */
	function ago(at: string): string {
		const seconds = Math.round((Date.parse(at) - Date.parse(clock.now)) / 1000);
		if (!Number.isFinite(seconds)) return '';
		if (Math.abs(seconds) < 60) return relative.format(0, 'second');
		const minutes = Math.round(seconds / 60);
		if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
		const hours = Math.round(minutes / 60);
		if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
		const days = Math.round(hours / 24);
		if (Math.abs(days) < 30) return relative.format(days, 'day');
		const months = Math.round(days / 30);
		return Math.abs(months) < 12
			? relative.format(months, 'month')
			: relative.format(Math.round(months / 12), 'year');
	}
	let refresh = $state(0);
	let open = $state(false);

	const actorKey = (actor: NonNullable<Checkpoint['actor']>) => `${actor.kind}:${actor.id}`;
	// who wrote a revision: a member by name when this caller may read them, else what kind of actor it was
	const names = new Map<string, string>();
	function who(actor: Checkpoint['actor']): Effect.Effect<string> {
		if (actor === null) return Effect.succeed(msg(bolt, 'record.actor.unknown'));
		if (actor.kind !== 'member')
			return Effect.succeed(
				catalogText(
					bolt,
					`record.actor.${actor.kind}`,
					actor.kind === 'system'
						? 'Automation'
						: actor.kind === 'api_key'
							? 'API key'
							: actor.kind === 'envoy'
								? 'Envoy'
								: 'Visitor'
				)
			);
		const known = names.get(actor.id);
		return known !== undefined
			? Effect.succeed(known)
			: bolt.query(by_id('sys_user', actor.id)).pipe(
					Effect.map((answer) => {
						const user = first_of(answer, 'sys_user');
						return String(user?.['name'] ?? user?.['email'] ?? actor.id);
					}),
					Effect.catch(() => Effect.succeed(actor.id)),
					Effect.tap((name) =>
						Effect.sync(() => {
							names.set(actor.id, name);
						})
					)
				);
	}

	/** A revision's changed fields, at most three named. */
	function changed(c: Checkpoint, model: string): string {
		if (c.fields.length === 0) return msg(bolt, 'record.noVisibleChanges');
		const named = c.fields
			.slice(0, 3)
			.map((f) => label(bolt, model, f))
			.join(', ');
		return c.fields.length > 3
			? msg(bolt, 'record.changedMore', { fields: named, more: c.fields.length - 3 })
			: named;
	}
	const ACTION_TEXT = {
		create: 'record.created',
		update: 'record.updated',
		move: 'record.moved',
		delete: 'record.erased',
		rollback: 'record.rolledBack'
	} as const;
	const states = (model: string) =>
		new Set(
			Object.entries(kinds.catalog?.[model]?.fields ?? {})
				.filter(([, kind]) => kind.kind === 'state')
				.map(([field]) => field)
		);
	type Event = { key: string; of: string; subject: string; checkpoint: Checkpoint; own: boolean };
	type LoadedHistory = { list: readonly Event[]; partial: boolean; names: ReadonlyMap<string, string> };
	function visible(c: Checkpoint, model: string, fields?: readonly string[]): Checkpoint {
		return {
			...c,
			fields: c.fields.filter(
				(f) =>
					!kinds.catalog?.[model]?.fields[f]?.hidden && (fields === undefined || fields.includes(f))
			)
		};
	}
	const rootHistory = observe_once<readonly Checkpoint[], Error>(() => (open ? history : null));
	const loaded = observe_once<LoadedHistory, Error>(() => {
		if (!open || history === null) return null;
		void refresh;
		if (rootHistory.loading || rootHistory.error !== undefined) return null;
		const root = rootHistory.current;
		if (root === undefined) return null;
		return Effect.gen(function* () {
			const related = yield* Effect.forEach(
				config.sources ?? [],
				(source) =>
					Effect.result(
						Effect.gen(function* () {
							const records =
								page_of(
									yield* bolt.query(
										kinds.catalog?.[source.of]?.record_label !== undefined
											? label_read(kinds.catalog, source.of, {
													where: source.where,
													limit: READ_LIMIT
												})
											: request_json({ [source.of]: { where: source.where, limit: READ_LIMIT } })
									),
									source.of
								)?.rows ?? [];
							const groups = yield* Effect.forEach(
								records,
								(row) =>
									bolt.history(source.of, row.id).pipe(
										Effect.map((answer) => {
											const subject =
												recordText(kinds.catalog?.[source.of], row) || label(bolt, source.of);
											return checkpoints(answer).map((checkpoint) => ({
												key: `${source.of}:${row.id}:${checkpoint.revision}`,
												of: source.of,
												subject,
												checkpoint: visible(checkpoint, source.of, source.fields),
												own: false
											}));
										})
									),
								{ concurrency: 'unbounded' }
							);
							return groups.flat();
						})
					),
				{ concurrency: 'unbounded' }
			);
			const list: Event[] = root.map((checkpoint) => ({
				key: `${of}:${checkpoint.revision}`,
				of,
				subject: label(bolt, of),
				checkpoint: visible(checkpoint, of, config.fields),
				own: true
			}));
			for (const result of related)
				if (result._tag === 'Success')
					list.push(
						...result.success.filter(
							(event) =>
								event.checkpoint.fields.length > 0 ||
								event.checkpoint.restored_from !== null ||
								event.checkpoint.approval !== null
						)
					);
			// every writer named once, before the timeline shows
			const actors = new Map(
				list.flatMap((e) => (e.checkpoint.actor === null ? [] : [[actorKey(e.checkpoint.actor), e.checkpoint.actor] as const]))
			);
			const names = new Map(
				yield* Effect.forEach([...actors], ([key, actor]) => Effect.map(who(actor), (name) => [key, name] as const), {
					concurrency: 'unbounded'
				})
			);
			return {
				names,
				list: list.sort(
					(a, b) =>
						// the live record's current revision anchors the timeline, whatever related records did later
						(b.own && b.checkpoint.revision >= latest ? 1 : 0) -
							(a.own && a.checkpoint.revision >= latest ? 1 : 0) ||
						(b.checkpoint.at ?? '').localeCompare(a.checkpoint.at ?? '') ||
						(b.own ? 1 : 0) - (a.own ? 1 : 0) ||
						b.checkpoint.revision - a.checkpoint.revision ||
						a.key.localeCompare(b.key)
				),
				partial: related.some((result) => result._tag === 'Failure')
			};
		});
	});
	// a decision on the record's requests is an entry of its own, among the revisions by when it was made
	type Decision = TimelineEntry & { at: string };
	const DECIDED = new Set<ApprovalView['log'][number]['move']>([
		'approve',
		'reject',
		'request_changes',
		'supersede',
		'withdraw'
	]);
	const decisions = $derived(
		approvals
			.flatMap((request) =>
				request.log.flatMap((e, i): Decision[] =>
					DECIDED.has(e.move)
						? [
								{
									key: `${request.id}:${i}`,
									at: e.at,
									action: e.move,
									line: [moveText(bolt, e.move), e.by.name ?? e.by.ref.replace(/^[a-z]+:/i, ''), stamp(e.at)],
									quote: e.reason,
									data: { 'data-history-decision': `${request.id}:${i}` }
								}
							]
						: []
				)
			)
			.sort((a, b) => b.at.localeCompare(a.at))
	);
	/** One revision as a timeline entry: what it did · who · when, its fields and request state quietly below. */
	function revisionEntry(event: Event, names: ReadonlyMap<string, string>): TimelineEntry {
		const c = event.checkpoint;
		const current = event.own && c.revision >= latest;
		const action = revisionAction(c, states(event.of));
		const what =
			action === 'restore'
				? msg(bolt, 'record.restored_from', { n: c.restored_from ?? 0 })
				: msg(bolt, ACTION_TEXT[action]);
		const by = c.actor === null ? msg(bolt, 'record.actor.unknown') : (names.get(actorKey(c.actor)) ?? c.actor.id);
		return {
			key: event.key,
			action,
			line: [
				event.own ? what : `${event.subject} · ${what}`,
				by,
				c.at === null ? stamp(c.at) : `${stamp(c.at)} (${ago(c.at)})`,
				`#${c.revision}`
			],
			notes: [
				...(action === 'update' || action === 'move' ? [{ kind: 'fields', text: changed(c, event.of) }] : []),
				...(c.approval?.state == null ? [] : [{ kind: 'approval', text: historyStatus(bolt, c.approval.state) }])
			],
			...(current
				? { mark: { text: msg(bolt, 'record.current') } }
				: c.valid
					? {}
					: { mark: { text: msg(bolt, 'record.historyInvalid'), warn: true } }),
			current,
			...(event.own ? { onpick: () => pick(event) } : {}),
			data: {
				'data-history-model': event.of,
				'data-history-revision': c.revision,
				'data-history-valid': c.valid
			}
		};
	}
	/** The entries newest first (the current revision leads), each decision before the revisions written ahead of it. */
	const merged = (result: LoadedHistory): readonly TimelineEntry[] => {
		const out: TimelineEntry[] = [];
		let next = 0;
		for (const event of result.list) {
			const at = event.own && event.checkpoint.revision >= latest ? null : event.checkpoint.at;
			for (; at !== null && next < decisions.length && (decisions[next]?.at ?? '') > at; next++) {
				const d = decisions[next];
				if (d !== undefined) out.push(d);
			}
			out.push(revisionEntry(event, result.names));
		}
		return [...out, ...decisions.slice(next)];
	};
	const pick = (event: Event) =>
		onpick(
			event.checkpoint.revision >= latest ? null : event.checkpoint.revision,
			event.checkpoint.at
		);
</script>

<Popover.Root
	bind:open
	on_open_change={(next) => {
		if (next) {
			refresh++;
			onload();
		}
	}}
>
	<Popover.Trigger
		class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
		aria-label={msg(bolt, 'record.history')}
		title={msg(bolt, 'record.revisionOf', {
			n: viewing ?? latest,
			total: latest
		})}
		data-timeline-trigger
	>
		<Glyph name="history" class="size-4" />
	</Popover.Trigger>
	<Popover.Content
		align="end"
		class="w-[min(26rem,calc(100vw-1rem))] overflow-hidden p-0"
		data-record-timeline
	>
		<div class="flex items-center justify-between gap-2 border-b px-3 py-2">
			<p class="text-sm font-medium">{msg(bolt, 'record.history')}</p>
			{#if viewing !== null}<button
					type="button"
					class="text-brand-text hover:bg-brand/10 focus-visible:ring-ring/40 rounded-md px-2 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
					data-record-history-current
					onclick={() => onpick(null, null)}
					>{msg(bolt, 'record.backToCurrent')}</button
				>{/if}
		</div>
		{#if open && history !== null}
			{#if rootHistory.loading || loaded.loading}<p
					role="status"
					class="text-muted-foreground px-3 py-4 text-sm"
				>
					{msg(bolt, 'record.historyLoading')}
				</p>
			{:else if rootHistory.error !== undefined || loaded.error !== undefined}<p
					role="alert"
					class="text-destructive px-3 py-4 text-sm"
				>
					{msg(bolt, 'record.noHistory')}
				</p>
			{:else}
				{@const result = loaded.current ?? { list: [], partial: false, names: new Map() }}
				<div class="max-h-96 overflow-y-auto px-3 py-3" data-record-history-events>
					{#if result.partial}<p role="status" class="text-muted-foreground mb-2 text-xs">
							{msg(bolt, 'record.historyPartial')}
						</p>{/if}
					<Timeline entries={merged(result)} label={msg(bolt, 'record.history')} />
				</div>
			{/if}
		{/if}
	</Popover.Content>
</Popover.Root>
