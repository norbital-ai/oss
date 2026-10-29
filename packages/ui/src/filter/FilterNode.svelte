<script lang="ts">
	// One filter row of the view popover (rule 16b): a condition (field ▸ operator ▸ operand ▸ value), an AND/OR/NOT
	// group, or a related-records row (relation ▸ quantifier ▸ value) with its nested conditions indented under it.
	// Every control is one height (the kit's CONTROL); a row carries no label beside a control that already names itself.
	// The field, operator, label, value and quantifier choices all come from the engine's catalogue (`filter.options`),
	// so the builder can author exactly what a description may be asked for.
	import type { ModelExposure } from '../kinds/context.js';
	import { CONTROL } from '../kinds/classes.js';
	import Editor from '../kinds/editor.svelte';
	import CodeEditor from '../editors/code-editor.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import type { Value } from '../kinds/kind.js';
	import Picker from '../kinds/picker.svelte';
	import { cn } from '../primitives/utils.js';
	import { useBolt } from '../client/context.js';
	import FieldPicker from './FieldPicker.svelte';
	import {
		argKind,
		taggedArg,
		childOf,
		fieldsFor,
		litKind,
		manyAt,
		manyOffers,
		offersFor,
		operandsFor,
		operatorsFor,
		pathLabel,
		QUANT_LABEL,
		radiusText,
		resolve,
		varError,
		variableOf,
		variablesFor,
		type Arg,
		type RawArg,
		type Cmp,
		type FilterStep,
		type Node,
		type Offer,
		type Op,
		type Quant,
		type Resolved
	} from './filter.js';
	import FilterNode from './FilterNode.svelte';
	import { humanize, msg } from '../text/messages.js';

	let {
		node,
		catalog,
		model,
		offers,
		prefix = [],
		top = false,
		onChange,
		onRemove
	}: {
		node: Node;
		catalog: { readonly [c: string]: ModelExposure };
		model: string;
		/** The engine's catalogue for the view. */
		offers: readonly Offer[];
		/** The many-relation steps this row sits under, so catalogue paths match. */
		prefix?: readonly FilterStep[];
		/** The view's own model outside any related group: many-relations are offered. */
		top?: boolean;
		onChange(next: Node): void;
		onRemove(): void;
	} = $props();
	const bolt = useBolt();
	const NO_VALUE: readonly Op[] = ['isNull', 'notNull', 'isEmpty', 'notEmpty'];
	const OPERAND_LABEL = { lit: 'a value', var: 'a variable', field: 'a field' } as const;
	const QUANTS: readonly Quant[] = ['some', 'none', 'every', 'count', 'sum', 'min', 'max', 'avg'];
	const endStep = (o: Offer): FilterStep | undefined => o.path.at(-1);
	const aggFn = (o: Offer): Quant | null => {
		const s = endStep(o);
		return s?.k === 'agg' ? s.fn : null;
	};
	const aggOf = (o: Offer): string | null => {
		const s = endStep(o);
		return s?.k === 'agg' ? s.of : null;
	};

	const blank: Node = { t: 'cond', path: '', op: 'eq', arg: null };
	const joinWord = (join: 'and' | 'or') =>
		join === 'and' ? msg(bolt, 'view.and', 'and') : msg(bolt, 'view.or', 'or');
	/** What follows a typed `@` in a value position (`null`: no variable menu open). */
	let variable = $state<string | null>(null);
	/** The variable expression being edited in its chip (`null`: not editing). */
	let draft = $state<string | null>(null);
	/** `@` opens the variable menu, unless it is part of a typed literal (`bob@example.com`). */
	const atKey = (e: KeyboardEvent, offered: boolean) => {
		const t = e.target;
		if (
			e.key !== '@' ||
			!offered ||
			(t instanceof HTMLInputElement && t.type === 'text' && t.value !== '')
		)
			return;
		e.preventDefault();
		variable = '';
	};
	/** A picked field starts on its first operator, so the row is never left without one. */
	function picked(path: string, many: boolean) {
		if (many) return onChange({ t: 'many', rel: path, q: 'some', of: [] });
		const r = resolve(catalog, model, path);
		onChange({
			t: 'cond',
			path,
			op: (r === null ? undefined : operatorsFor(offers, prefix, path, r)[0]?.op) ?? 'eq',
			arg: null
		});
	}
	/** A new operand of `kind`: a variable opens the `@` menu, a field names the first same-kind field. */
	function operand(kind: string, path: string): Arg | null {
		if (kind === 'var') variable = '';
		const first = kind === 'field' ? fieldsFor(catalog, model, path)[0] : undefined;
		return first === undefined ? null : { _tag: 'field', field: first };
	}
	const setArg = (arg: Arg | null) => node.t === 'cond' && onChange({ ...node, arg });
	const list = $derived(
		node.t === 'cond' && node.arg !== null && 'list' in node.arg ? node.arg.list : []
	);
	const setList = (next: readonly Value[]) =>
		setArg(next.length === 0 ? null : { _tag: 'list', list: next });
	const children = (n: Extract<Node, { t: 'group' | 'many' }>, of: readonly Node[]) =>
		onChange({ ...n, of } as Node);
	const setQuant = (m: Extract<Node, { t: 'many' }>, q: Quant) => {
		if (q === 'some' || q === 'none' || q === 'every')
			return onChange({ t: 'many', rel: m.rel, q, of: m.of });
		const at =
			q === 'count'
				? manyOffers(offers, prefix, m.rel).count
				: manyOffers(offers, prefix, m.rel).aggs.filter((o) => aggFn(o) === q);
		onChange({
			t: 'many',
			rel: m.rel,
			q,
			of: [],
			op: (at[0]?.op ?? 'gte') as Cmp,
			n: m.n ?? null,
			...(q === 'count' ? {} : { field: aggOf(at[0]!) ?? undefined })
		});
	};
</script>

{#snippet remove()}
	<button
		type="button"
		class="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto grid size-9 shrink-0 place-items-center rounded-sm"
		aria-label={msg(bolt, 'view.removeRow', 'Remove')}
		data-remove
		onclick={onRemove}
	>
		<svg
			viewBox="0 0 24 24"
			class="size-4"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg
		>
	</button>
{/snippet}

{#snippet nested(
	n: Extract<Node, { t: 'group' | 'many' }>,
	at: string,
	isTop: boolean,
	atPrefix: readonly FilterStep[]
)}
	<div class="border-border ml-2 flex flex-col gap-1.5 border-l-2 pl-3" data-nested>
		{#each n.of as child, i (i)}
			{#if i > 0}
				{#if n.t === 'group'}
					<!-- the group's combinator between its conditions: one click switches every "and" to "or" -->
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground hover:bg-muted self-start rounded-sm border px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase"
						data-join-toggle={n.join}
						title={msg(bolt, 'view.switchJoin', 'Switch between all of and any of')}
						onclick={() => onChange({ ...n, join: n.join === 'and' ? 'or' : 'and' })}
						>{joinWord(n.join)}</button
					>
				{:else}
					<span
						class="text-muted-foreground text-[11px] font-medium tracking-wide uppercase"
						data-join="and">{joinWord('and')}</span
					>
				{/if}
			{/if}
			<FilterNode
				node={child}
				{catalog}
				model={at}
				{offers}
				prefix={atPrefix}
				top={isTop}
				onChange={(c) =>
					children(
						n,
						n.of.map((x, j) => (j === i ? c : x))
					)}
				onRemove={() =>
					children(
						n,
						n.of.filter((_, j) => j !== i)
					)}
			/>
		{/each}
		<div class="flex gap-3 text-xs">
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground"
				data-add-nested
				onclick={() => children(n, [...n.of, blank])}
			>
				+ {msg(bolt, 'view.addCondition', 'Add condition')}
			</button>
			{#if n.t === 'group'}
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground"
					data-add-nested-group
					onclick={() =>
						children(n, [
							...n.of,
							{ t: 'group', join: n.join === 'and' ? 'or' : 'and', of: [blank] }
						])}
				>
					+ {msg(bolt, 'view.addGroup', 'Add group')}
				</button>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet one(r: Resolved, value: Value, set: (v: Value) => void)}
	{#if r.leaf === 'rel'}
		<div class="w-48">
			<Picker of={r.targets[0]!} value={typeof value === 'string' ? value : null} onChange={set} />
		</div>
	{:else if node.t === 'cond'}
		{@const k = litKind(r, node.op)}
		{#if k.kind === 'bool'}
			<Combobox
				class="w-auto"
				options={[
					{ value: 'true', label: msg(bolt, 'view.yes', 'Yes') },
					{ value: 'false', label: msg(bolt, 'view.no', 'No') }
				]}
				value={value === null ? null : value === true ? 'true' : 'false'}
				onChange={(b) => set(b === null ? null : b === 'true')}
			/>
		{:else}
			<div class="w-48"><Editor kind={k} {value} onChange={set} name={node.path} /></div>
		{/if}
	{/if}
{/snippet}

{#if node.t === 'group'}
	{@const g = node}
	<div class="bg-muted/20 flex flex-col gap-1.5 rounded-md border p-2" data-group={g.join}>
		<div class="flex items-center gap-1.5">
			<Combobox
				class="w-auto"
				aria-label={msg(bolt, 'view.join', 'Match')}
				value={`${g.not ? 'not-' : ''}${g.join}`}
				options={[
					{ value: 'and', label: msg(bolt, 'view.all', 'All of') },
					{ value: 'or', label: msg(bolt, 'view.any', 'Any of') },
					{ value: 'not-and', label: msg(bolt, 'view.notAll', 'Not all of') },
					{ value: 'not-or', label: msg(bolt, 'view.none', 'None of') }
				]}
				onChange={(v) => {
					if (v !== null)
						onChange({
							t: 'group',
							join: v.endsWith('or') ? 'or' : 'and',
							...(v.startsWith('not') ? { not: true } : {}),
							of: g.of
						});
				}}
			/>
			<span class="text-muted-foreground text-sm"
				>{msg(bolt, 'view.theseConditions', 'these conditions')}</span
			>
			{@render remove()}
		</div>
		{@render nested(g, model, top, prefix)}
	</div>
{:else if node.t === 'many'}
	{@const m = node}
	{@const child = childOf(catalog, model, m.rel) ?? ''}
	{@const agg = m.q !== 'some' && m.q !== 'none' && m.q !== 'every'}
	{@const mo = manyOffers(offers, prefix, m.rel)}
	<!-- has any / has none are the grammar's for every many-relation, all match at the view's own model; count and totals
	     are the catalogue's -->
	{@const quantOptions = QUANTS.filter((q) =>
		q === 'some' || q === 'none'
			? true
			: q === 'every'
				? prefix.length === 0 && !m.rel.includes('.')
				: q === 'count'
					? mo.count.length > 0
					: mo.aggs.some((o) => aggFn(o) === q)
	)}
	{@const aggAt = agg
		? m.q === 'count'
			? mo.count
			: mo.aggs.filter((o) => aggFn(o) === m.q && aggOf(o) === m.field)
		: []}
	<div class="flex flex-col gap-1.5" data-many={m.rel}>
		<div class="flex flex-wrap items-center gap-1.5">
			<FieldPicker {catalog} {model} {offers} {prefix} value={m.rel} many={top} onPick={picked} />
			<Combobox
				class="w-auto"
				aria-label={msg(bolt, 'view.quantifier', 'Quantifier')}
				value={m.q}
				options={quantOptions.map((q) => ({
					value: q,
					label: msg(bolt, `view.q.${q}`, QUANT_LABEL[q])
				}))}
				onChange={(q) => {
					if (q !== null) setQuant(m, q);
				}}
			/>
			{#if agg && m.q !== 'count'}
				<Combobox
					class="w-auto"
					aria-label={msg(bolt, 'view.of', 'Of')}
					value={m.field ?? null}
					onChange={(f) => {
						if (f !== null) onChange({ ...m, field: f });
					}}
					options={[...new Set(mo.aggs.filter((o) => aggFn(o) === m.q).map((o) => aggOf(o)!))].map(
						(f) => ({ value: f, label: catalog[child]?.fields[f]?.label ?? humanize(f) })
					)}
				/>
			{/if}
			{#if agg}
				<Combobox
					class="w-auto"
					aria-label={msg(bolt, 'view.compare', 'Compare')}
					value={m.op ?? null}
					onChange={(op) => {
						if (op !== null) onChange({ ...m, op: op as Cmp });
					}}
					options={aggAt.map((o) => ({ value: o.op, label: o.opLabel }))}
				/>
				<input
					class={cn(CONTROL, 'w-24')}
					type="number"
					min={m.q === 'count' ? 0 : undefined}
					step={m.q === 'count' ? 1 : 'any'}
					value={m.n ?? ''}
					aria-label={msg(bolt, 'view.number', 'Number')}
					oninput={(e) =>
						onChange({
							...m,
							n: e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
						})}
				/>
			{/if}
			{@render remove()}
		</div>
		{#if !agg}
			{@const at = manyAt(prefix, m.rel)}
			{@const rel = pathLabel(catalog, model, m.rel, humanize)}
			{#if m.of.length > 0}
				<p class="text-muted-foreground ml-2 text-xs" data-many-heading>
					{m.q === 'every'
						? msg(bolt, 'view.many.every', 'Every {rel} matches all of:', { rel })
						: m.q === 'none'
							? msg(bolt, 'view.many.none', 'No {rel} matches all of:', { rel })
							: msg(bolt, 'view.many.some', 'At least one {rel} matches all of:', { rel })}
				</p>
			{/if}
			{@render nested(m, child, false, [
				...at.prefix,
				{ k: m.q as 'some' | 'every' | 'none', rel: at.name }
			])}
		{/if}
	</div>
{:else}
	{@const r = node.path === '' ? null : resolve(catalog, model, node.path)}
	{@const at = offersFor(offers, prefix, node.path)}
	<div class="flex flex-wrap items-center gap-1.5" data-cond={node.path}>
		<FieldPicker {catalog} {model} {offers} {prefix} value={node.path} many={top} onPick={picked} />
		{#if r !== null}
			{@const c = node}
			{@const operands = operandsFor(r, c.op).filter(
				(o) => o !== 'field' || fieldsFor(catalog, model, c.path).length > 0
			)}
			<Combobox
				class="w-auto"
				aria-label={msg(bolt, 'view.operator', 'Operator')}
				value={c.op}
				onChange={(op) => {
					if (op !== null) onChange({ ...c, op, arg: null });
				}}
				placeholder={msg(bolt, 'view.operator', 'Operator')}
				options={[
					...operatorsFor(offers, prefix, c.path, r).map((o) => ({ value: o.op, label: o.label })),
					...(c.op === 'near' && !at.some((o) => o.op === 'near')
						? [{ value: 'near' as const, label: msg(bolt, 'view.near', 'is within') }]
						: [])
				]}
			/>
			{#if c.op === 'near' && c.arg !== null && 'lit' in c.arg && Array.isArray(c.arg.lit)}
				<!-- a described "near <place>": the radius is editable; the place is where the found record is -->
				{@const [p, m] = c.arg.lit as [{ lat: number; lng: number }, number]}
				<input
					class={cn(CONTROL, 'w-24')}
					type="number"
					min="0.1"
					step="0.1"
					aria-label={msg(bolt, 'view.radius', 'Kilometres')}
					value={m / 1000}
					oninput={(e) => {
						const km = Number(e.currentTarget.value);
						if (km > 0) setArg({ _tag: 'lit', lit: [p, Math.round(km * 1000)] });
					}}
				/>
				<span class="text-muted-foreground text-sm" data-near
					>{msg(bolt, 'view.kmOf', 'km of')}
					{p.lat.toFixed(4)}, {p.lng.toFixed(4)}
					<span class="sr-only">({radiusText(m)})</span></span
				>
			{:else if !NO_VALUE.includes(c.op)}
				{@const variables = c.op === 'during' || c.op === 'like' ? [] : variablesFor(r, c.op)}
				{@const named = variableOf(c.arg)}
				<!-- svelte-ignore a11y_no_static_element_interactions: it only listens for the `@` its controls receive -->
				<div
					class="relative flex flex-wrap items-center gap-1.5"
					data-value
					onkeydown={(e) => atKey(e, variables.length > 0)}
				>
					{#if variable !== null}
						{@const matching = variables.filter((v) => v.name.startsWith(variable ?? ''))}
						<input
							class={cn(CONTROL, 'w-40')}
							type="text"
							role="combobox"
							aria-expanded="true"
							aria-controls="filter-variables"
							aria-label={msg(bolt, 'view.variable', 'Variable')}
							data-variable-input
							value={`@${variable}`}
							{@attach (el) => el.focus()}
							oninput={(e) => (variable = e.currentTarget.value.replace(/^@/, ''))}
							onkeydown={(e) => {
								e.stopPropagation();
								if (e.key === 'Escape') variable = null;
								else if (e.key === 'Enter' && matching[0] !== undefined) {
									e.preventDefault();
									setArg(matching[0].arg);
									variable = null;
								}
							}}
							onblur={() => (variable = null)}
						/>
						<ul
							id="filter-variables"
							role="listbox"
							class="bg-popover absolute top-full left-0 z-50 mt-1 min-w-40 rounded-md border p-1 shadow-md"
							data-variables
						>
							{#each matching as v (v.name)}
								<li role="option" aria-selected="false" data-variable-option={v.name}>
									<button
										type="button"
										class="hover:bg-muted w-full rounded-sm px-2 py-1 text-left text-sm"
										onmousedown={(e) => e.preventDefault()}
										onclick={() => {
											setArg(v.arg);
											variable = null;
										}}>@{v.name}</button
									>
								</li>
							{/each}
						</ul>
					{:else if draft !== null && c.arg !== null && 'var' in c.arg}
						{@const error = varError(r, c.op, draft)}
						<div class="flex min-w-48 flex-col gap-0.5" data-variable-editor>
							<CodeEditor
								class={cn(CONTROL, 'h-auto w-64 py-1')}
								language="javascript"
								wrap
								minHeight="1.75rem"
								invalid={error !== undefined}
								value={draft}
								aria-label={msg(bolt, 'view.expression', 'Expression')}
								onChange={(next) => {
									draft = next;
									if (varError(r, c.op, next) === undefined) setArg({ _tag: 'var', var: next });
								}}
							/>
							{#if error !== undefined}<span class="text-destructive text-xs" data-variable-error
									>{error}</span
								>{/if}
						</div>
						<button
							type="button"
							class="text-muted-foreground text-sm"
							onclick={() => (draft = null)}>{msg(bolt, 'view.done', 'Done')}</button
						>
					{:else if named !== undefined && c.arg !== null && 'var' in c.arg}
						{@const text = c.arg.var}
						<span
							class="bg-muted inline-flex h-9 items-center gap-1 rounded-sm px-2 text-sm"
							data-variable={named}
							><button
								type="button"
								class="font-mono"
								aria-label={msg(bolt, 'view.editVariable', 'Edit variable')}
								onclick={() => (draft = text)}>@{named}</button
							>
							<button
								type="button"
								aria-label={msg(bolt, 'view.removeValue', 'Remove value')}
								onclick={() => setArg(null)}>×</button
							></span
						>
					{/if}
					{#if c.op !== 'during' && c.op !== 'like' && operands.length > 1}
						{@const lit =
							r.leaf === 'rel'
								? 'record'
								: r.kind.kind === 'date' || r.kind.kind === 'instant' || r.kind.kind === 'period'
									? 'date'
									: 'lit'}
						<Combobox
							class="w-auto"
							aria-label={msg(bolt, 'view.operand', 'Compare with')}
							value={argKind(c.arg)}
							onChange={(o) => setArg(operand(o ?? 'lit', c.path))}
							options={operands.map((o) => ({
								value: o,
								label:
									o === 'lit'
										? msg(
												bolt,
												`view.operand.${lit}`,
												lit === 'record' ? 'a record' : lit === 'date' ? 'a date' : 'a value'
											)
										: msg(bolt, `view.operand.${o}`, OPERAND_LABEL[o])
							}))}
						/>
					{/if}
					{#if c.op === 'during'}
						{@const values = at.find((o) => o.op === 'during')?.values ?? []}
						<Combobox
							class="w-auto"
							aria-label={msg(bolt, 'view.period', 'Period')}
							value={c.arg !== null && 'range' in c.arg ? JSON.stringify(c.arg.range) : null}
							display={c.arg !== null && 'range' in c.arg
								? (c.arg.label ??
									(c.arg.range.every((bound) => typeof bound === 'string')
										? c.arg.range.map((bound) => String(bound).slice(0, 10)).join(' – ')
										: undefined))
								: undefined}
							onChange={(v) => {
								const pick = values.find((x) => JSON.stringify(x.arg) === v);
								setArg(
									pick === undefined
										? null
										: taggedArg({
												...pick.arg,
												...('range' in pick.arg ? { label: pick.label } : {})
											})
								);
							}}
							options={values.map((v) => ({ value: JSON.stringify(v.arg), label: v.label }))}
						/>
					{:else if c.arg !== null && 'var' in c.arg}
						<!-- a variable: the chip is the value -->
					{:else if c.arg !== null && 'field' in c.arg}
						<Combobox
							class="w-auto"
							aria-label={msg(bolt, 'view.field', 'Field')}
							value={c.arg.field}
							onChange={(f) => {
								if (f !== null) setArg({ _tag: 'field', field: f });
							}}
							options={fieldsFor(catalog, model, c.path).map((f) => ({
								value: f,
								label: catalog[model]?.fields[f]?.label ?? humanize(f)
							}))}
						/>
					{:else if c.op === 'like'}
						<input
							class={cn(CONTROL, 'w-48')}
							type="text"
							aria-label={msg(bolt, 'view.text', 'Text')}
							value={c.arg !== null && 'lit' in c.arg ? String(c.arg.lit ?? '') : ''}
							oninput={(e) =>
								setArg(
									e.currentTarget.value === '' ? null : { _tag: 'lit', lit: e.currentTarget.value }
								)}
						/>
					{:else if c.op === 'in' || c.op === 'nin' || c.op === 'hasAny' || c.op === 'hasAll'}
						<div class="flex flex-wrap items-center gap-1.5" data-list>
							{#each list as item, i (i)}
								{#if r.leaf === 'rel'}
									{@render one(r, item, (v) =>
										setList(
											v === null
												? list.filter((_, j) => j !== i)
												: list.map((x, j) => (j === i ? v : x))
										)
									)}
								{:else}
									<span class="bg-muted inline-flex h-9 items-center gap-1 rounded-sm px-2 text-sm"
										>{String(item)}
										<button
											type="button"
											aria-label={msg(bolt, 'view.removeValue', 'Remove value')}
											onclick={() => setList(list.filter((_, j) => j !== i))}>×</button
										></span
									>
								{/if}
							{/each}
							{#key list.length}{@render one(
									r,
									null,
									(v) => v !== null && v !== '' && setList([...list, v])
								)}{/key}
						</div>
					{:else}
						{@render one(r, c.arg !== null && 'lit' in c.arg ? c.arg.lit : null, (v) =>
							setArg(v === null || v === '' ? null : { _tag: 'lit', lit: v })
						)}
					{/if}
				</div>
			{/if}
		{/if}
		{@render remove()}
	</div>
{/if}
