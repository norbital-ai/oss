<!--
@component
The record header's history trigger opens a popover with the revision ruler and details. Dragging, clicking or the arrow
keys pick a revision; `End`/`Escape` return to the current one.
-->
<script lang="ts">
	import { useBolt } from './bolt.js';
	import * as Popover from '../primitives/popover/index.js';
	import Glyph from './Glyph.svelte';
	import { drawnTicks, label, msg, show, tickAt, tickOf, type Checkpoint } from './model.js';

	let { of, latest, viewing, history, onload, onpick }: {
		of: string;
		/** The live record's revision: the ruler runs `1..latest`. */
		latest: number;
		/** The revision shown in the body; `null` is the live record. */
		viewing: number | null;
		/** The revisions' details, read on first opening (`onload`); `null` until then. */
		history: Promise<readonly Checkpoint[]> | null;
		onload: () => void;
		/** A revision to show; `null` (or `latest`) returns to the live record. */
		onpick: (revision: number | null) => void;
	} = $props();
	const bolt = useBolt();
	// ponytail: at most ~120 drawn ticks; picking stays per revision (pointer and keys), only the drawing is sampled
	const MAX = 120;

	const at = $derived(viewing ?? latest);
	const ticks = $derived(drawnTicks(latest, MAX, at));
	let hover = $state<number | null>(null);
	let dragging = $state(false);
	let open = $state(false);
	let track = $state<HTMLElement | null>(null);

	const revAt = (x: number) => { const b = track!.getBoundingClientRect(); return tickOf(b.width === 0 ? 1 : (x - b.left) / b.width, latest); };
	const pick = (r: number) => { hover = r; onpick(r >= latest ? null : r); };
	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		track!.setPointerCapture(e.pointerId);
		dragging = true;
		hover = revAt(e.clientX);
	}
	function up(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		pick(revAt(e.clientX));
	}
	function key(e: KeyboardEvent) {
		const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? at - 1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? at + 1
			: e.key === 'PageDown' ? at - 10 : e.key === 'PageUp' ? at + 10 : e.key === 'Home' ? 1 : e.key === 'End' || e.key === 'Escape' ? latest : null;
		if (next === null || (e.key === 'Escape' && viewing === null)) return;
		e.preventDefault();
		pick(Math.min(latest, Math.max(1, next)));
	}

	// who wrote a revision: a member by name when this caller may read them, else what kind of actor it was
	const names = new Map<string, Promise<string>>();
	function who(a: Checkpoint['actor']): Promise<string> {
		if (a === null) return Promise.resolve(msg(bolt, 'record.actor.unknown', 'Unknown'));
		if (a.kind !== 'member') return Promise.resolve(msg(bolt, `record.actor.${a.kind}`, a.kind === 'system' ? 'Automation' : a.kind === 'apiKey' ? 'API key' : a.kind === 'envoy' ? 'Envoy' : 'Visitor'));
		let n = names.get(a.id);
		if (n === undefined) names.set(a.id, n = Promise.resolve(bolt.get<{ readonly [f: string]: unknown } | null>('sys_user', a.id)).then((u) => String(u?.['name'] ?? u?.['email'] ?? a.id), () => a.id));
		return n;
	}
	function what(c: Checkpoint): string {
		if (c.revision === 1) return msg(bolt, 'record.created', 'Created');
		if (c.fields.length === 0) return msg(bolt, 'record.noVisibleChanges', 'No visible changes');
		const named = c.fields.slice(0, 3).map((f) => label(bolt, of, f)).join(', ');
		return c.fields.length > 3 ? msg(bolt, 'record.changedMore', '{fields} +{more}', { fields: named, more: c.fields.length - 3 }) : named;
	}
	const place = (r: number) => `left:${tickAt(r, latest)}%`;
	// a label at a tick stays inside the ruler: pinned left at the start, right at the end
	const pinned = (r: number) => `left:${tickAt(r, latest)}%;transform:translateX(-${tickAt(r, latest)}%)`;
</script>

<Popover.Root bind:open onOpenChange={(next) => { if (next) { onload(); queueMicrotask(() => track?.focus()); } else hover = null; }}>
	<Popover.Trigger class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 grid size-8 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2"
		aria-label={msg(bolt, 'record.history', 'History')} title={msg(bolt, 'record.revisionOf', 'Revision {n} of {total}', { n: at, total: latest })} data-timeline-trigger>
		<Glyph name="history" class="size-4" />
	</Popover.Trigger>
	<Popover.Content align="end" class="w-[min(32rem,calc(100vw-1rem))] p-3" data-record-timeline>
	<div class="select-none" role="group" aria-label={msg(bolt, 'record.history', 'History')}
		onpointerleave={() => { if (!dragging) hover = null; }}>
		<p class="text-sm font-medium">{msg(bolt, 'record.history', 'History')}</p>
	<div class="flex h-8 items-stretch gap-1">
		<button type="button" tabindex="-1" class="text-muted-foreground hover:text-foreground hover:bg-muted grid w-8 shrink-0 place-items-center rounded-md disabled:opacity-40"
			aria-label={msg(bolt, 'record.previousRevision', 'Previous revision')} disabled={at <= 1} onclick={() => pick(at - 1)}><Glyph name="left" class="size-3.5" /></button>
		<div bind:this={track} role="slider" tabindex="0" aria-orientation="horizontal"
			aria-label={msg(bolt, 'record.history', 'History')} aria-valuemin={1} aria-valuemax={latest} aria-valuenow={at}
			aria-valuetext={viewing === null ? msg(bolt, 'record.current', 'Current') : msg(bolt, 'record.revisionOf', 'Revision {n} of {total}', { n: at, total: latest })}
			class="focus-visible:ring-ring/40 relative min-w-0 flex-1 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-2"
			onpointerdown={down} onpointerup={up} onpointercancel={() => { dragging = false; hover = null; }}
			onpointermove={(e) => (hover = revAt(e.clientX))} onkeydown={key} onfocus={() => (hover ??= at)} onblur={() => { if (!dragging) hover = null; }}>
			<!-- minor ticks: a light ruler under the checkpoints -->
			<span aria-hidden="true" class="absolute inset-x-0 bottom-2 h-px bg-[repeating-linear-gradient(to_right,var(--color-border)_0_1px,transparent_1px_6px)]"></span>
			{#each ticks as r (r)}
				<span aria-hidden="true" style={place(r)}
					class={['absolute bottom-2 h-2 w-px -translate-x-1/2', r <= at ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30']}></span>
			{/each}
			{#if hover !== null}
				<!-- the pointer's line and its revision above it -->
				<span aria-hidden="true" class="bg-brand pointer-events-none absolute inset-y-1 w-px" style={place(hover)}></span>
				<span aria-hidden="true" class="text-tiny text-muted-foreground pointer-events-none absolute top-0 leading-3 tabular-nums" style={pinned(hover)}>{hover}</span>
			{/if}
			<!-- the playhead: the revision the body shows -->
			<span aria-hidden="true" data-playhead={at} style={place(at)}
				class="bg-brand pointer-events-none absolute bottom-1.5 h-4 w-1.5 -translate-x-1/2 rounded-full"></span>
		</div>
		<button type="button" tabindex="-1" class="text-muted-foreground hover:text-foreground hover:bg-muted grid w-8 shrink-0 place-items-center rounded-md disabled:opacity-40"
			aria-label={msg(bolt, 'record.nextRevision', 'Next revision')} disabled={viewing === null} onclick={() => pick(at + 1)}><Glyph name="right" class="size-3.5" /></button>
	</div>
	{#if hover !== null}
		<!-- the hovered revision: when, who, what changed -->
		<div class="px-1 pb-2">
			<div role="status" data-timeline-card={hover}
				class="text-muted-foreground flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
				{#await history}
					<div class="bg-muted h-3 w-32 animate-pulse rounded motion-reduce:animate-none"></div>
				{:then list}
					{@const c = list?.find((x) => x.revision === hover)}
					{#if c === undefined}
						<p class="text-muted-foreground">{msg(bolt, 'record.revisionGone', 'Revision {n}: no details', { n: hover })}</p>
					{:else}
						<span class="text-foreground font-medium tabular-nums">{show(c.at, bolt.locale)}</span><span class="tabular-nums">#{c.revision}</span>
						<span class="truncate">{#await who(c.actor)}…{:then name}{name}{/await}</span>
						<span class="truncate">{what(c)}</span>
					{/if}
				{:catch}
					<p class="text-destructive">{msg(bolt, 'record.noHistory', 'No access to this record’s history')}</p>
				{/await}
			</div>
		</div>
	{/if}
	</div>
	</Popover.Content>
</Popover.Root>
