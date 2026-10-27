<!--
@component
The record header's history trigger opens a popover with the revision ruler and details. Dragging, clicking or the arrow
keys pick a revision; `End`/`Escape` return to the current one.
-->
<script lang="ts">
	import { formatValue as show } from '../kinds/kind.js';
	import { Effect } from 'effect';
	import { observeOnce, run } from '../effect/index.js';
	import { format } from '../kinds/kind.js';
	import { useKinds } from '../kinds/context.js';
	import type { RecordHistoryConfig } from './history.js';
	import { useBolt } from '../client/context.js';
	import * as Popover from '../primitives/popover/index.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { checkpoints, drawnTicks, tickAt, tickOf, type Checkpoint } from './history.js';
	import { rowsOf } from '../read/results.js';
	import { byId, firstOf, pageOf, READ_LIMIT, requestJson } from '../read/request.js';
	import { label, msg } from '../text/messages.js';

	let {
		of,
		latest,
		viewing,
		history,
		config = {},
		onload,
		onpick
	}: {
		of: string;
		config?: RecordHistoryConfig;
		/** The live record's revision: the ruler runs `1..latest`. */
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
	const bolt = useBolt();
	const kinds = useKinds();
	const stamp = (at: Checkpoint['at']) =>
		format({ kind: 'instant' }, at, { locale: bolt.locale, zone: kinds.zone });
	let refresh = $state(0);
	// ponytail: at most ~120 drawn ticks; picking stays per revision (pointer and keys), only the drawing is sampled
	const MAX = 120;

	const at = $derived(viewing ?? latest);
	const ticks = $derived(drawnTicks(latest, MAX, at));
	let hover = $state<number | null>(null);
	const detail = $derived(hover ?? at);
	let dragging = $state(false);
	let open = $state(false);
	let track = $state<HTMLElement | null>(null);

	const revAt = (x: number) => {
		const b = track?.getBoundingClientRect();
		if (b === undefined) return at;
		return tickOf(b.width === 0 ? 1 : (x - b.left) / b.width, latest);
	};
	// the instant revision `r` was written: its own checkpoint's, else the last before it (a pruned revision)
	const atOf = (r: number) =>
		rootHistory.current?.filter((c) => c.revision <= r).at(-1)?.at ?? null;
	const pick = (r: number) => {
		hover = r;
		onpick(r >= latest ? null : r, atOf(r));
	};
	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		track?.setPointerCapture(e.pointerId);
		dragging = true;
		hover = revAt(e.clientX);
	}
	function up(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		pick(revAt(e.clientX));
	}
	function key(e: KeyboardEvent) {
		const next =
			e.key === 'ArrowLeft' || e.key === 'ArrowDown'
				? at - 1
				: e.key === 'ArrowRight' || e.key === 'ArrowUp'
					? at + 1
					: e.key === 'PageDown'
						? at - 10
						: e.key === 'PageUp'
							? at + 10
							: e.key === 'Home'
								? 1
								: e.key === 'End' || e.key === 'Escape'
									? latest
									: null;
		if (next === null || (e.key === 'Escape' && viewing === null)) return;
		e.preventDefault();
		pick(Math.min(latest, Math.max(1, next)));
	}

	// who wrote a revision: a member by name when this caller may read them, else what kind of actor it was
	const names = new Map<string, string>();
	function who(actor: Checkpoint['actor']): Effect.Effect<string> {
		if (actor === null) return Effect.succeed(msg(bolt, 'record.actor.unknown', 'Unknown'));
		if (actor.kind !== 'member')
			return Effect.succeed(
				msg(
					bolt,
					`record.actor.${actor.kind}`,
					actor.kind === 'system'
						? 'Automation'
						: actor.kind === 'apiKey'
							? 'API key'
							: actor.kind === 'envoy'
								? 'Envoy'
								: 'Visitor'
				)
			);
		const known = names.get(actor.id);
		return known !== undefined
			? Effect.succeed(known)
			: bolt.query(byId('sys_user', actor.id)).pipe(
					Effect.map((answer) => {
						const user = firstOf(answer, 'sys_user');
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

	function what(c: Checkpoint, model = of): string {
		const base = described(c, model);
		// an approval's provisional change says where its request stands; a rollback says it was the request's
		return c.approval === null || c.approval.state === null
			? base
			: c.restoredFrom !== null
				? msg(bolt, 'record.rolledBackBy', '{what} · rolled back ({state})', {
						what: base,
						state: c.approval.state
					})
				: msg(bolt, 'record.underRequest', '{what} · approval {state}', {
						what: base,
						state: c.approval.state
					});
	}
	function described(c: Checkpoint, model: string): string {
		if (c.restoredFrom !== null)
			return msg(bolt, 'record.restoredFrom', 'Restored from revision {n}', { n: c.restoredFrom });
		if (c.revision === 1) return msg(bolt, 'record.created', 'Created');
		if (c.fields.length === 0) return msg(bolt, 'record.noVisibleChanges', 'No visible changes');
		const named = c.fields
			.slice(0, 3)
			.map((f) => label(bolt, model, f))
			.join(', ');
		return c.fields.length > 3
			? msg(bolt, 'record.changedMore', '{fields} +{more}', {
					fields: named,
					more: c.fields.length - 3
				})
			: named;
	}
	type Event = { key: string; of: string; subject: string; checkpoint: Checkpoint; own: boolean };
	type LoadedHistory = { list: readonly Event[]; partial: boolean };
	function visible(c: Checkpoint, model: string, fields?: readonly string[]): Checkpoint {
		return {
			...c,
			fields: c.fields.filter(
				(f) =>
					!kinds.catalog?.[model]?.fields[f]?.hidden && (fields === undefined || fields.includes(f))
			)
		};
	}
	const rootHistory = observeOnce<readonly Checkpoint[], Error>(() => (open ? history : null));
	const loaded = observeOnce<LoadedHistory, Error>(() => {
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
							const records = rowsOf(
								pageOf(
									yield* bolt.query(
										requestJson({ [source.of]: { where: source.where, limit: READ_LIMIT } })
									),
									source.of
								)
							);
							const groups = yield* Effect.forEach(
								records,
								(row) =>
									bolt.history(source.of, row.id).pipe(
										Effect.map((answer) => {
											const subject =
												(kinds.catalog?.[source.of]?.label ?? [])
													.map((field) => show(row[field], bolt.locale))
													.filter(Boolean)
													.join(' · ') || label(bolt, source.of);
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
			for (const result of related) if (result._tag === 'Success') list.push(...result.success);
			return {
				list: list.sort(
					(a, b) =>
						(b.checkpoint.at ?? '').localeCompare(a.checkpoint.at ?? '') ||
						a.key.localeCompare(b.key)
				),
				partial: related.some((result) => result._tag === 'Failure')
			};
		});
	});
	const place = (r: number) => `left:${tickAt(r, latest)}%`;
	// a label at a tick stays inside the ruler: pinned left at the start, right at the end
	const pinned = (r: number) =>
		`left:${tickAt(r, latest)}%;transform:translateX(-${tickAt(r, latest)}%)`;
</script>

<Popover.Root
	bind:open
	onOpenChange={(next) => {
		if (next) {
			refresh++;
			onload();
			queueMicrotask(() => track?.focus());
		} else hover = null;
	}}
>
	<Popover.Trigger
		class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 grid size-8 max-sm:size-11 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
		aria-label={msg(bolt, 'record.history', 'History')}
		title={msg(bolt, 'record.revisionOf', 'Revision {n} of {total}', { n: at, total: latest })}
		data-timeline-trigger
	>
		<Glyph name="history" class="size-4" />
	</Popover.Trigger>
	<Popover.Content align="end" class="w-[min(32rem,calc(100vw-1rem))] p-3" data-record-timeline>
		<div
			class="select-none"
			role="group"
			aria-label={msg(bolt, 'record.history', 'History')}
			onpointerleave={() => {
				if (!dragging) hover = null;
			}}
		>
			<p class="text-sm font-medium">{msg(bolt, 'record.history', 'History')}</p>
			<div class="flex h-8 items-stretch gap-1">
				<button
					type="button"
					tabindex="-1"
					class="text-muted-foreground hover:text-foreground hover:bg-muted grid w-8 shrink-0 place-items-center rounded-md disabled:opacity-40"
					aria-label={msg(bolt, 'record.previousRevision', 'Previous revision')}
					disabled={at <= 1}
					onclick={() => pick(at - 1)}><Glyph name="left" class="size-3.5" /></button
				>
				<div
					bind:this={track}
					role="slider"
					tabindex="0"
					aria-orientation="horizontal"
					aria-label={msg(bolt, 'record.history', 'History')}
					aria-valuemin={1}
					aria-valuemax={latest}
					aria-valuenow={at}
					aria-valuetext={viewing === null
						? msg(bolt, 'record.current', 'Current')
						: msg(bolt, 'record.revisionOf', 'Revision {n} of {total}', { n: at, total: latest })}
					class="focus-visible:ring-ring/40 relative min-w-0 flex-1 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-2"
					onpointerdown={down}
					onpointerup={up}
					onpointercancel={() => {
						dragging = false;
						hover = null;
					}}
					onpointermove={(e) => (hover = revAt(e.clientX))}
					onkeydown={key}
					onfocus={() => (hover ??= at)}
					onblur={() => {
						if (!dragging) hover = null;
					}}
				>
					<!-- minor ticks: a light ruler under the checkpoints -->
					<span
						aria-hidden="true"
						class="absolute inset-x-0 bottom-2 h-px bg-[repeating-linear-gradient(to_right,var(--color-border)_0_1px,transparent_1px_6px)]"
					></span>
					{#each ticks as r (r)}
						<span
							aria-hidden="true"
							style={place(r)}
							class={[
								'absolute bottom-2 h-2 w-px -translate-x-1/2',
								r <= at ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30'
							]}
						></span>
					{/each}
					{#if hover !== null}
						<!-- the pointer's line and its revision above it -->
						<span
							aria-hidden="true"
							class="bg-brand pointer-events-none absolute inset-y-1 w-px"
							style={place(hover)}
						></span>
						<span
							aria-hidden="true"
							class="text-tiny text-muted-foreground pointer-events-none absolute top-0 leading-3 tabular-nums"
							style={pinned(hover)}>{hover}</span
						>
					{/if}
					<!-- the playhead: the revision the body shows -->
					<span
						aria-hidden="true"
						data-playhead={at}
						style={place(at)}
						class="bg-brand pointer-events-none absolute bottom-1.5 h-4 w-1.5 -translate-x-1/2 rounded-full"
					></span>
				</div>
				<button
					type="button"
					tabindex="-1"
					class="text-muted-foreground hover:text-foreground hover:bg-muted grid w-8 shrink-0 place-items-center rounded-md disabled:opacity-40"
					aria-label={msg(bolt, 'record.nextRevision', 'Next revision')}
					disabled={viewing === null}
					onclick={() => pick(at + 1)}><Glyph name="right" class="size-3.5" /></button
				>
			</div>
			<!-- the selected or hovered revision: when, who, what changed -->
			<div class="px-1 pb-2">
				<div
					role="status"
					data-timeline-card={detail}
					class="text-muted-foreground flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs"
				>
					{#if rootHistory.loading}
						<div class="bg-muted h-3 w-32 animate-pulse rounded motion-reduce:animate-none"></div>
					{:else if rootHistory.error !== undefined}
						<p class="text-destructive">
							{msg(bolt, 'record.noHistory', 'No access to this record’s history')}
						</p>
					{:else}
						{@const c = rootHistory.current?.find((x) => x.revision === detail)}
						{#if c === undefined}
							<p class="text-muted-foreground">
								{msg(bolt, 'record.revisionGone', 'Revision {n}: no details', { n: detail })}
							</p>
						{:else}
							<span class="text-foreground font-medium tabular-nums">{stamp(c.at)}</span><span
								class="tabular-nums">#{c.revision}</span
							>
							<span class="truncate">{#await run(who(c.actor))}…{:then name}{name}{/await}</span>
							<span class="truncate">{what(visible(c, of, config.fields))}</span>
						{/if}
					{/if}
				</div>
			</div>
		</div>
		{#if open && history !== null}
			{#if rootHistory.loading || loaded.loading}<p
					role="status"
					class="text-sm text-muted-foreground"
				>
					{msg(bolt, 'record.historyLoading', 'Loading history…')}
				</p>
			{:else if rootHistory.error !== undefined || loaded.error !== undefined}<p
					role="alert"
					class="text-sm text-destructive"
				>
					{msg(bolt, 'record.noHistory', 'No access to this record’s history')}
				</p>
			{:else}
				{@const result = loaded.current ?? { list: [], partial: false }}
				{#if result.partial}<p role="status" class="text-sm text-muted-foreground">
						{msg(bolt, 'record.historyPartial', 'Some related history is unavailable.')}
					</p>{/if}
				<ol
					class="mt-3 max-h-80 space-y-3 overflow-y-auto border-l border-border pl-3"
					data-record-history-events
				>
					{#each result.list as event (event.key)}<li class="text-sm" data-history-model={event.of}>
							{#if event.own}<button
									type="button"
									class="text-left font-medium hover:underline"
									onclick={() =>
										onpick(
											event.checkpoint.revision >= latest ? null : event.checkpoint.revision,
											event.checkpoint.at
										)}>{event.subject} · {what(event.checkpoint, event.of)}</button
								>
							{:else}<p class="font-medium">
									{event.subject} · {what(event.checkpoint, event.of)}
								</p>{/if}
							<p class="text-xs text-muted-foreground">
								{stamp(event.checkpoint.at)} · {#await run(who(event.checkpoint.actor))}…{:then name}{name}{/await}
							</p>
						</li>{/each}
				</ol>
			{/if}
		{/if}
	</Popover.Content>
</Popover.Root>
