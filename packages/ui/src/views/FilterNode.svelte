<script lang="ts">
	// One filter row of the view popover (rule 16b): a condition (field ▸ operator ▸ operand ▸ value), an AND/OR/NOT
	// group, or a related-records row (relation ▸ quantifier ▸ value) with its nested conditions indented under it.
	// Every control is one height (the kit's CONTROL); a row carries no label beside a control that already names itself.
	// The field, operator, label, value and quantifier choices all come from the engine's catalogue (`filter.options`),
	// so the builder can author exactly what a description may be asked for.
	import type { CollectionExposure } from '../kinds/context.js';
	import { CONTROL } from '../kinds/classes.js';
	import Editor from '../kinds/editor.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import type { Json, Kind } from '../kinds/kind.js';
	import Picker from '../kinds/picker.svelte';
	import { cn } from '../primitives/utils.js';
	import { useBolt } from './bolt.js';
	import FieldPicker from './FieldPicker.svelte';
	import {
		argKind, childOf, manyOffers, offersFor, operandsFor, QUANT_LABEL, radiusText, resolve, valueKind,
		type Arg, type Cmp, type FilterStep, type Node, type Offer, type Op, type Quant, type Resolved, type Unit,
	} from './filter.js';
	import FilterNode from './FilterNode.svelte';
	import { humanize, msg } from './model.js';

	let { node, catalog, collection, offers, prefix = [], top = false, onChange, onRemove }: {
		node: Node;
		catalog: { readonly [c: string]: CollectionExposure };
		collection: string;
		/** The engine's catalogue for the view. */
		offers: readonly Offer[];
		/** The many-relation steps this row sits under, so catalogue paths match. */
		prefix?: readonly FilterStep[];
		/** The view's own collection outside any related group: many-relations are offered. */
		top?: boolean;
		onChange(next: Node): void;
		onRemove(): void;
	} = $props();
	const bolt = useBolt();
	const NO_VALUE: readonly Op[] = ['isNull', 'notNull', 'isEmpty', 'notEmpty'];
	const OPERAND_LABEL = { lit: 'a value', today: 'days from today', now: 'days from now', startOf: 'start of', me: 'me', party: 'my party', team: 'my teams' } as const;
	const QUANTS: readonly Quant[] = ['some', 'none', 'every', 'count', 'sum', 'min', 'max', 'avg'];
	const endStep = (o: Offer): FilterStep | undefined => o.path.at(-1);
	const aggFn = (o: Offer): Quant | null => { const s = endStep(o); return s?.k === 'agg' ? s.fn : null; };
	const aggOf = (o: Offer): string | null => { const s = endStep(o); return s?.k === 'agg' ? s.of : null; };

	const blank: Node = { t: 'cond', path: '', op: 'eq', arg: null };
	function picked(path: string, many: boolean) {
		if (many) return onChange({ t: 'many', rel: path, q: 'some', of: [] });
		onChange({ t: 'cond', path, op: (offersFor(offers, prefix, path)[0]?.op ?? 'eq') as Op, arg: null });
	}
	function operand(kind: string): Arg | null {
		switch (kind) {
			case 'today': return { today: '' };
			case 'now': return { now: '' };
			case 'startOf': return { startOf: 'week' };
			case 'me': return { actor: 'id' };
			case 'party': return { actor: 'party' };
			case 'team': return { actor: 'teams' };
			default: return null;
		}
	}
	const days = (offset: string) => { const m = /^([+-])(\d+)d$/.exec(offset); return m === null ? 0 : Number(m[2]) * (m[1] === '-' ? -1 : 1); };
	const offset = (n: number) => !Number.isFinite(n) || n === 0 ? '' : `${n > 0 ? '+' : '-'}${Math.abs(Math.trunc(n))}d`;
	const litKind = (r: Extract<Resolved, { leaf: 'field' }>, op: Op): Kind =>
		op === 'contains' && r.kind.kind === 'period' ? { kind: r.kind.of } : valueKind(r.kind);
	const setArg = (arg: Arg | null) => node.t === 'cond' && onChange({ ...node, arg });
	const list = $derived(node.t === 'cond' && node.arg !== null && 'list' in node.arg ? node.arg.list : []);
	const setList = (next: readonly Json[]) => setArg(next.length === 0 ? null : { list: next });
	const children = (n: Extract<Node, { t: 'group' | 'many' }>, of: readonly Node[]) => onChange({ ...n, of } as Node);
	const setQuant = (m: Extract<Node, { t: 'many' }>, q: Quant) => {
		if (q === 'some' || q === 'none' || q === 'every') return onChange({ t: 'many', rel: m.rel, q, of: m.of });
		const at = q === 'count' ? manyOffers(offers, prefix, m.rel).count : manyOffers(offers, prefix, m.rel).aggs.filter((o) => aggFn(o) === q);
		onChange({ t: 'many', rel: m.rel, q, of: [], op: (at[0]?.op ?? 'gte') as Cmp, n: m.n ?? null, ...(q === 'count' ? {} : { field: aggOf(at[0]!) ?? undefined }) });
	};
</script>

{#snippet remove()}
	<button type="button" class="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto grid size-9 shrink-0 place-items-center rounded-sm"
		aria-label={msg(bolt, 'view.removeRow', 'Remove')} data-remove onclick={onRemove}>
		<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
	</button>
{/snippet}

{#snippet nested(n: Extract<Node, { t: 'group' | 'many' }>, at: string, isTop: boolean, atPrefix: readonly FilterStep[])}
	<div class="border-border ml-2 flex flex-col gap-1.5 border-l pl-3" data-nested>
		{#each n.of as child, i (i)}
			<FilterNode node={child} {catalog} collection={at} {offers} prefix={atPrefix} top={isTop}
				onChange={(c) => children(n, n.of.map((x, j) => j === i ? c : x))} onRemove={() => children(n, n.of.filter((_, j) => j !== i))} />
		{/each}
		<button type="button" class="text-muted-foreground hover:text-foreground self-start text-xs" data-add-nested onclick={() => children(n, [...n.of, blank])}>
			+ {msg(bolt, 'view.addCondition', 'Add condition')}
		</button>
	</div>
{/snippet}

{#snippet one(r: Resolved, value: Json, set: (v: Json) => void)}
	{#if r.leaf === 'rel'}
		<div class="w-48"><Picker of={r.targets[0]!} value={typeof value === 'string' ? value : null} onChange={set} /></div>
	{:else if node.t === 'cond'}
		{@const k = litKind(r, node.op)}
		{#if k.kind === 'bool'}
			<Combobox class="w-auto" options={[{ value: 'true', label: msg(bolt, 'view.yes', 'Yes') }, { value: 'false', label: msg(bolt, 'view.no', 'No') }]}
				value={value === null ? null : value === true ? 'true' : 'false'} onChange={(b) => set(b === null ? null : b === 'true')} />
		{:else}
			<div class="w-48"><Editor kind={k} {value} onChange={set} name={node.path} /></div>
		{/if}
	{/if}
{/snippet}

{#if node.t === 'group'}
	{@const g = node}
	<div class="flex flex-col gap-1.5 rounded-md border p-2" data-group={g.join}>
		<div class="flex items-center gap-1.5">
			<Combobox class="w-auto" aria-label={msg(bolt, 'view.join', 'Match')} value={`${g.not ? 'not-' : ''}${g.join}`}
				options={[{ value: 'and', label: msg(bolt, 'view.all', 'All of') }, { value: 'or', label: msg(bolt, 'view.any', 'Any of') },
					{ value: 'not-and', label: msg(bolt, 'view.notAll', 'Not all of') }, { value: 'not-or', label: msg(bolt, 'view.none', 'None of') }]}
				onChange={(v) => { if (v !== null) onChange({ t: 'group', join: v.endsWith('or') ? 'or' : 'and', ...(v.startsWith('not') ? { not: true } : {}), of: g.of }); }} />
			{@render remove()}
		</div>
		{@render nested(g, collection, top, prefix)}
	</div>
{:else if node.t === 'many'}
	{@const m = node}
	{@const child = childOf(catalog, collection, m.rel) ?? ''}
	{@const agg = m.q !== 'some' && m.q !== 'none' && m.q !== 'every'}
	{@const mo = manyOffers(offers, prefix, m.rel)}
	{@const quantOptions = QUANTS.filter((q) => q === 'some' || q === 'none' || q === 'every' ? mo.all : q === 'count' ? mo.count.length > 0 : mo.aggs.some((o) => aggFn(o) === q))}
	{@const aggAt = agg ? (m.q === 'count' ? mo.count : mo.aggs.filter((o) => aggFn(o) === m.q && aggOf(o) === m.field)) : []}
	<div class="flex flex-col gap-1.5" data-many={m.rel}>
		<div class="flex flex-wrap items-center gap-1.5">
			<FieldPicker {catalog} {collection} {offers} {prefix} value={m.rel} many={top} onPick={picked} />
			<Combobox class="w-auto" aria-label={msg(bolt, 'view.quantifier', 'Quantifier')} value={m.q}
				options={quantOptions.map((q) => ({ value: q, label: msg(bolt, `view.q.${q}`, QUANT_LABEL[q]) }))}
				onChange={(q) => { if (q !== null) setQuant(m, q); }} />
			{#if agg && m.q !== 'count'}
				<Combobox class="w-auto" aria-label={msg(bolt, 'view.of', 'Of')} value={m.field ?? null} onChange={(f) => { if (f !== null) onChange({ ...m, field: f }); }}
					options={[...new Set(mo.aggs.filter((o) => aggFn(o) === m.q).map((o) => aggOf(o)!))].map((f) => ({ value: f, label: catalog[child]?.fields[f]?.label ?? humanize(f) }))} />
			{/if}
			{#if agg}
				<Combobox class="w-auto" aria-label={msg(bolt, 'view.compare', 'Compare')} value={m.op ?? null} onChange={(op) => { if (op !== null) onChange({ ...m, op: op as Cmp }); }}
					options={aggAt.map((o) => ({ value: o.op, label: o.opLabel }))} />
				<input class={cn(CONTROL, 'w-24')} type="number" min={m.q === 'count' ? 0 : undefined} step={m.q === 'count' ? 1 : 'any'} value={m.n ?? ''}
					aria-label={msg(bolt, 'view.number', 'Number')} oninput={(e) => onChange({ ...m, n: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })} />
			{/if}
			{@render remove()}
		</div>
		{#if !agg}{@render nested(m, child, false, [...prefix, { k: m.q as 'some' | 'every' | 'none', rel: m.rel }])}{/if}
	</div>
{:else}
	{@const r = node.path === '' ? null : resolve(catalog, collection, node.path)}
	{@const at = offersFor(offers, prefix, node.path)}
	<div class="flex flex-wrap items-center gap-1.5" data-cond={node.path}>
		<FieldPicker {catalog} {collection} {offers} {prefix} value={node.path} many={top} onPick={picked} />
		{#if r !== null}
			{@const c = node}
			{@const operands = operandsFor(r, c.op)}
			<Combobox class="w-auto" aria-label={msg(bolt, 'view.operator', 'Operator')} value={c.op} onChange={(op) => { if (op !== null) onChange({ ...c, op: op as Op, arg: null }); }}
				options={[...at.map((o) => ({ value: o.op, label: o.opLabel })), ...(c.op === 'near' && !at.some((o) => o.op === 'near') ? [{ value: 'near', label: msg(bolt, 'view.near', 'is within') }] : [])]} />
			{#if c.op === 'near' && c.arg !== null && 'lit' in c.arg && Array.isArray(c.arg.lit)}
				<!-- a described "near <place>": the radius is editable; the place is where the found record is -->
				{@const [p, m] = c.arg.lit as [{ lat: number; lng: number }, number]}
				<input class={cn(CONTROL, 'w-24')} type="number" min="0.1" step="0.1" aria-label={msg(bolt, 'view.radius', 'Kilometres')} value={m / 1000}
					oninput={(e) => { const km = Number(e.currentTarget.value); if (km > 0) setArg({ lit: [p, Math.round(km * 1000)] }); }} />
				<span class="text-muted-foreground text-sm" data-near>{msg(bolt, 'view.kmOf', 'km of')} {p.lat.toFixed(4)}, {p.lng.toFixed(4)} <span class="sr-only">({radiusText(m)})</span></span>
			{:else if !NO_VALUE.includes(c.op)}
				{#if c.op !== 'during' && c.op !== 'like' && operands.length > 1}
					{@const lit = r.leaf === 'rel' ? 'record' : r.kind.kind === 'date' || r.kind.kind === 'instant' || r.kind.kind === 'period' ? 'date' : 'lit'}
					<Combobox class="w-auto" aria-label={msg(bolt, 'view.operand', 'Compare with')} value={argKind(c.arg)} onChange={(o) => setArg(operand(o ?? 'lit'))}
						options={operands.map((o) => ({ value: o, label: o === 'lit' ? msg(bolt, `view.operand.${lit}`, lit === 'record' ? 'a record' : lit === 'date' ? 'a date' : 'a value') : msg(bolt, `view.operand.${o}`, OPERAND_LABEL[o]) }))} />
				{/if}
				{#if c.op === 'during'}
					{@const values = at.find((o) => o.op === 'during')?.values ?? []}
					<Combobox class="w-auto" aria-label={msg(bolt, 'view.period', 'Period')} value={c.arg !== null && 'range' in c.arg ? JSON.stringify(c.arg.range) : null}
						onChange={(v) => { const pick = values.find((x) => JSON.stringify(x.arg) === v); setArg(pick === undefined ? null : { ...pick.arg, ...('range' in pick.arg ? { label: pick.label } : {}) } as Arg); }}
						options={values.map((v) => ({ value: JSON.stringify(v.arg), label: v.label }))} />
				{:else if c.arg !== null && ('today' in c.arg || 'now' in c.arg)}
					{@const key = 'today' in c.arg ? 'today' : 'now'}
					<input class={cn(CONTROL, 'w-20')} type="number" step="1" aria-label={msg(bolt, 'view.days', 'Days')}
						value={days('today' in c.arg ? c.arg.today : 'now' in c.arg ? c.arg.now : '')}
						oninput={(e) => setArg(key === 'today' ? { today: offset(Number(e.currentTarget.value)) } : { now: offset(Number(e.currentTarget.value)) })} />
				{:else if c.arg !== null && 'startOf' in c.arg}
					{@const s = c.arg}
					<Combobox class="w-auto" aria-label={msg(bolt, 'view.shift', 'Which')} value={String(s.shift ?? 0)}
						onChange={(v) => { const n = Number(v ?? 0); setArg(n === 0 ? { startOf: s.startOf } : { startOf: s.startOf, shift: n }); }}
						options={[...new Set([-1, 0, 1, s.shift ?? 0])].map((n) => ({ value: String(n), label: ({ [-1]: 'last', 0: 'this', 1: 'next' } as { readonly [k: number]: string })[n] ?? String(n) }))} />
					<Combobox class="w-auto" aria-label={msg(bolt, 'view.unit', 'Unit')} value={s.startOf} onChange={(u) => { if (u !== null) setArg({ ...s, startOf: u as Unit }); }}
						options={(['week', 'month', 'quarter', 'year'] as const).map((u) => ({ value: u, label: msg(bolt, `view.unit.${u}`, u) }))} />
				{:else if c.arg !== null && 'actor' in c.arg}
					<!-- me / my party / my teams: the operand is the value -->
				{:else if c.op === 'like'}
					<input class={cn(CONTROL, 'w-48')} type="text" aria-label={msg(bolt, 'view.text', 'Text')} value={c.arg !== null && 'lit' in c.arg ? String(c.arg.lit ?? '') : ''}
						oninput={(e) => setArg(e.currentTarget.value === '' ? null : { lit: e.currentTarget.value })} />
				{:else if c.op === 'in' || c.op === 'nin' || c.op === 'hasAny' || c.op === 'hasAll'}
					<div class="flex flex-wrap items-center gap-1.5" data-list>
						{#each list as item, i (i)}
							{#if r.leaf === 'rel'}
								{@render one(r, item, (v) => setList(v === null ? list.filter((_, j) => j !== i) : list.map((x, j) => j === i ? v : x)))}
							{:else}
								<span class="bg-muted inline-flex h-9 items-center gap-1 rounded-sm px-2 text-sm">{String(item)}
									<button type="button" aria-label={msg(bolt, 'view.removeValue', 'Remove value')} onclick={() => setList(list.filter((_, j) => j !== i))}>×</button></span>
							{/if}
						{/each}
						{#key list.length}{@render one(r, null, (v) => v !== null && v !== '' && setList([...list, v]))}{/key}
					</div>
				{:else}
					{@render one(r, c.arg !== null && 'lit' in c.arg ? c.arg.lit : null, (v) => setArg(v === null || v === '' ? null : { lit: v }))}
				{/if}
			{/if}
		{/if}
		{@render remove()}
	</div>
{/if}
