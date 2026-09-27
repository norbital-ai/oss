<!--
@component
The record header's history scrubber: a ruler of the record's revisions, the one shown marked. Quiet at rest; on hover or
focus it opens (taller ticks, prev/next, the hovered revision's when, who and what). Dragging, clicking a tick or the
arrow keys pick a revision; `End`/`Escape` return to the current one. On a phone it is a compact control that taps open.
-->
<script lang="ts">
	import { useBolt } from './bolt.js';
	import Glyph from './Glyph.svelte';
	import { drawnTicks, label, msg, show, tickAt, tickOf, type Checkpoint } from './model.js';

	let { of, latest, viewing, history, onload, onpick }: {
		of: string;
		/** The live record's revision: the ruler runs `1..latest`. */
		latest: number;
		/** The revision shown in the body; `null` is the live record. */
		viewing: number | null;
		/** The revisions' details, read on first hover or focus (`onload`); `null` until then. */
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
	/** A phone's compact control, tapped open. */
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
	// a label or card at a tick stays inside the ruler: pinned left at the start, right at the end
	const pinned = (r: number) => `left:${tickAt(r, latest)}%;transform:translateX(-${tickAt(r, latest)}%)`;
</script>

<!-- a phone shows a compact control; tapping it opens the ruler below -->
<button type="button" class="text-meta hover:text-foreground focus-visible:ring-ring/40 flex h-6 items-center gap-1.5 rounded-md px-1 outline-none focus-visible:ring-2 md:hidden"
	aria-expanded={open} data-timeline-compact onclick={() => { open = !open; onload(); }}>
	<Glyph name="history" class="size-3.5" />
	<span class="tabular-nums">{msg(bolt, 'record.revisionOf', 'Revision {n} of {total}', { n: at, total: latest })}</span>
</button>

<div class={['group/tl relative z-10 h-3 select-none', open ? 'mt-1 block' : 'hidden md:block']} role="group" aria-label={msg(bolt, 'record.history', 'History')} data-record-timeline data-open={open || dragging || undefined}
	onpointerenter={onload} onfocusin={onload} onpointerleave={() => { if (!dragging) hover = null; }}>
	<div class="bg-popover absolute inset-x-0 top-0 flex h-3 items-stretch gap-1 transition-[height] duration-150 group-focus-within/tl:h-9 group-hover/tl:h-9 group-data-open/tl:h-9 motion-reduce:transition-none">
		<button type="button" tabindex="-1" class="text-muted-foreground hover:text-foreground hover:bg-muted hidden w-6 shrink-0 place-items-center rounded-md disabled:opacity-40 group-focus-within/tl:grid group-hover/tl:grid group-data-open/tl:grid"
			aria-label={msg(bolt, 'record.previousRevision', 'Previous revision')} disabled={at <= 1} onclick={() => pick(at - 1)}><Glyph name="left" class="size-3.5" /></button>
		<div bind:this={track} role="slider" tabindex="0" aria-orientation="horizontal"
			aria-label={msg(bolt, 'record.history', 'History')} aria-valuemin={1} aria-valuemax={latest} aria-valuenow={at}
			aria-valuetext={viewing === null ? msg(bolt, 'record.current', 'Current') : msg(bolt, 'record.revisionOf', 'Revision {n} of {total}', { n: at, total: latest })}
			class="focus-visible:ring-ring/40 relative min-w-0 flex-1 cursor-pointer touch-none rounded-sm outline-none focus-visible:ring-2"
			onpointerdown={down} onpointerup={up} onpointercancel={() => { dragging = false; hover = null; }}
			onpointermove={(e) => (hover = revAt(e.clientX))} onkeydown={key} onfocus={() => (hover ??= at)} onblur={() => { if (!dragging) hover = null; }}>
			<!-- minor ticks: a light ruler under the checkpoints -->
			<span aria-hidden="true" class="absolute inset-x-0 bottom-0 h-1 bg-[repeating-linear-gradient(to_right,var(--color-border)_0_1px,transparent_1px_6px)] group-hover/tl:h-1.5"></span>
			{#each ticks as r (r)}
				<span aria-hidden="true" style={place(r)}
					class={['absolute bottom-0 w-px -translate-x-1/2 transition-[height] duration-150 motion-reduce:transition-none', r <= at ? 'bg-muted-foreground/60' : 'bg-muted-foreground/30',
						'h-2 group-focus-within/tl:h-3.5 group-hover/tl:h-3.5 group-data-open/tl:h-3.5']}></span>
			{/each}
			{#if hover !== null}
				<!-- the pointer's line and its revision above it -->
				<span aria-hidden="true" class="bg-brand pointer-events-none absolute inset-y-0 w-px" style={place(hover)}></span>
				<span aria-hidden="true" class="text-tiny text-muted-foreground pointer-events-none absolute top-0 leading-3 tabular-nums" style={pinned(hover)}>{hover}</span>
			{/if}
			<!-- the playhead: the revision the body shows -->
			<span aria-hidden="true" data-playhead={at} style={place(at)}
				class={['pointer-events-none absolute bottom-0 w-1.5 -translate-x-1/2 rounded-full bg-brand transition-[height] duration-150 motion-reduce:transition-none',
					'h-2.5 group-focus-within/tl:h-5 group-hover/tl:h-5 group-data-open/tl:h-5']}></span>
		</div>
		<button type="button" tabindex="-1" class="text-muted-foreground hover:text-foreground hover:bg-muted hidden w-6 shrink-0 place-items-center rounded-md disabled:opacity-40 group-focus-within/tl:grid group-hover/tl:grid group-data-open/tl:grid"
			aria-label={msg(bolt, 'record.nextRevision', 'Next revision')} disabled={viewing === null} onclick={() => pick(at + 1)}><Glyph name="right" class="size-3.5" /></button>
	</div>
	{#if hover !== null}
		<!-- the hovered revision: when, who, what changed -->
		<div class="pointer-events-none absolute inset-x-7 top-10">
			<div role="status" data-timeline-card={hover} style={pinned(hover)}
				class="bg-popover text-popover-foreground absolute top-0 w-max max-w-64 rounded-md border px-2.5 py-1.5 text-xs shadow-md">
				{#await history}
					<div class="bg-muted h-3 w-32 animate-pulse rounded motion-reduce:animate-none"></div>
				{:then list}
					{@const c = list?.find((x) => x.revision === hover)}
					{#if c === undefined}
						<p class="text-muted-foreground">{msg(bolt, 'record.revisionGone', 'Revision {n}: no details', { n: hover })}</p>
					{:else}
						<p class="flex items-baseline justify-between gap-3"><span class="font-medium tabular-nums">{show(c.at, bolt.locale)}</span><span class="text-muted-foreground tabular-nums">#{c.revision}</span></p>
						<p class="text-muted-foreground truncate">{#await who(c.actor)}…{:then name}{name}{/await}</p>
						<p class="truncate">{what(c)}</p>
					{/if}
				{:catch}
					<p class="text-destructive">{msg(bolt, 'record.noHistory', 'No access to this record’s history')}</p>
				{/await}
			</div>
		</div>
	{/if}
</div>
