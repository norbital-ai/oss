<script lang="ts">
	// One filter row of the view popover (rule 16b): a condition (field ▸ operator ▸ operand ▸ value), an AND/OR/NOT
	// group, or a related-records row (relation ▸ quantifier ▸ value) with its nested conditions indented under it.
	// Each condition is one editable sentence. Scope headers explain how their child conditions combine.
	// The field, operator, label, value and quantifier choices all come from the engine's catalogue (`filter.options`),
	// so the builder can author exactly what a description may be asked for.
	import * as Popover from '../primitives/popover/index.js';
	import { tick } from 'svelte';
	import AddFilter from './AddFilter.svelte';
	import type { ModelExposure } from '../kinds/context.js';
	import { CONTROL } from '../kinds/classes.js';
	import Editor from '../kinds/editor.svelte';
	import CodeEditor from '../editors/code-editor.svelte';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import type { Value } from '../kinds/kind.js';
	import Picker from '../kinds/picker.svelte';
	import { cn, stepActive } from '../primitives/utils.js';
	import { useBolt } from '../client/context.js';
	import FieldPicker from './FieldPicker.svelte';
	import {
		selectField,
		selectOperator,
		selectQuantifier,
		aggregateValue,
		aggFn,
		aggOf,
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
		QUANT_LABEL,
		OP_LABEL,
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
		type Resolved,
		type FilterVariables
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
		variables,
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
		variables?: FilterVariables;
		onChange(next: Node): void;
		onRemove(): void;
	} = $props();
	const bolt = useBolt();
	let expanded = $state(true);
	let operandOpen = $state(false);
	const scopeId = $props.id();
	const quantLabel = (q: Quant) =>
		q === 'some'
			? msg(bolt, 'view.scope.some', 'At least one record in')
			: q === 'none'
				? msg(bolt, 'view.scope.none', 'No record in')
				: q === 'every'
					? msg(bolt, 'view.scope.every', 'Every record in')
					: msg(bolt, `view.q.${q}`, QUANT_LABEL[q]);

	const NO_VALUE: readonly Op[] = ['isNull', 'notNull', 'isEmpty', 'notEmpty'];
	const OPERAND_LABEL = { lit: 'a value', var: 'a variable', field: 'a field' } as const;
	const QUANTS: readonly Quant[] = ['some', 'none', 'every', 'count', 'sum', 'min', 'max', 'avg'];

	const blank: Node = { t: 'cond', path: '', op: 'eq', arg: null };
	/** What follows a typed `@` in a value position (`null`: no variable menu open). */
	let variable = $state<string | null>(null);
	/** The variable menu's active row. */
	let variableActive = $state(0);
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
		variableActive = 0;
	};
	const commit = (next: Node) => {
		if (next === node) return;
		expanded = true;
		variable = null;
		draft = null;
		operandOpen = false;
		onChange(next);
	};
	function picked(path: string, many: boolean) {
		commit(selectField(catalog, model, node, path, many, offers, prefix, variables));
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
	const children = (n: Extract<Node, { t: 'group' | 'many' }>, of: readonly Node[]) => {
		if (of.length > n.of.length) expanded = true;
		onChange({ ...n, of } as Node);
	};
</script>

{#snippet remove()}
	<button
		type="button"
		class="filter-remove text-muted-foreground hover:bg-muted hover:text-foreground ml-auto grid size-8 shrink-0 place-items-center rounded-sm"
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

{#snippet toggleScope()}
	<button
		type="button"
		class="scope-toggle"
		aria-expanded={expanded}
		aria-controls={scopeId}
		aria-label={expanded
			? msg(bolt, 'view.hideConditions', 'Hide conditions')
			: msg(bolt, 'view.showConditions', 'Show conditions')}
		onclick={() => (expanded = !expanded)}
		data-scope-toggle
	>
		<svg
			viewBox="0 0 24 24"
			class={cn('size-3', expanded && 'rotate-90')}
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg
		>
	</button>
{/snippet}

{#snippet nested(
	n: Extract<Node, { t: 'group' | 'many' }>,
	at: string,
	isTop: boolean,
	atPrefix: readonly FilterStep[]
)}
	<div class="scope-body" id={scopeId} hidden={!expanded} data-nested>
		{#each n.of as child, i (i)}
			<div class="scope-branch">
				<FilterNode
					node={child}
					{catalog}
					model={at}
					{offers}
					{variables}
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
			</div>
		{/each}
	</div>
{/snippet}

{#snippet addScope(n: Extract<Node, { t: 'group' | 'many' }>)}
	<AddFilter
		nested
		iconOnly
		onCondition={() => children(n, [...n.of, blank])}
		onGroup={() => children(n, [...n.of, { t: 'group', join: 'or', of: [blank] }])}
	/>
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
				variant="ghost"
				class="w-auto"
				options={[
					{ value: 'true', label: msg(bolt, 'view.yes', 'Yes') },
					{ value: 'false', label: msg(bolt, 'view.no', 'No') }
				]}
				value={value === null ? null : value === true ? 'true' : 'false'}
				onChange={(b) => set(b === null ? null : b === 'true')}
			/>
		{:else}
			<div
				class="literal-value"
				style:width={k.kind === 'enum'
					? 'auto'
					: k.kind === 'text'
						? `clamp(5rem, ${String(value ?? '').length + 3}ch, 16rem)`
						: k.kind === 'int' || k.kind === 'number' || k.kind === 'decimal'
							? '6rem'
							: '11rem'}
			>
				<Editor kind={k} {value} onChange={set} name={node.path} />
			</div>
		{/if}
	{/if}
{/snippet}

{#if node.t === 'group'}
	{@const g = node}
	<section
		class="filter-scope"
		role="group"
		aria-label={msg(bolt, 'view.group', 'Condition group')}
		data-group={g.join}
	>
		<div class="scope-header">
			{@render toggleScope()}
			<div class="scope-sentence">
				<Combobox
					variant="ghost"
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
				<span class="scope-tail">{msg(bolt, 'view.theseConditions', 'these conditions')}</span>
			</div>
			<div class="scope-actions">{@render addScope(g)}{@render remove()}</div>
		</div>
		{@render nested(g, model, top, prefix)}
	</section>
{:else if node.t === 'many'}
	{@const m = node}
	{@const child = childOf(catalog, model, m.rel) ?? ''}
	{@const agg = m.q !== 'some' && m.q !== 'none' && m.q !== 'every'}
	{@const mo = manyOffers(offers, prefix, m.rel)}
	<!-- has any / has none are the grammar's for every many-relation, all match at the view's own model; count and totals
	     are the catalogue's -->
	{@const quantOptions = QUANTS.filter(
		(q) =>
			// keep a loaded or described choice visible while its catalogue is loading or absent
			q === m.q ||
			(q === 'some' || q === 'none'
				? true
				: q === 'every'
					? prefix.length === 0 && !m.rel.includes('.')
					: q === 'count'
						? mo.count.length > 0
						: mo.aggs.some((o) => aggFn(o) === q))
	)}
	{@const aggAt = agg
		? m.q === 'count'
			? mo.count
			: mo.aggs.filter((o) => aggFn(o) === m.q && aggOf(o) === m.field)
		: []}
	{@const compareOptions = [
		...aggAt.map((o) => ({ value: o.op, label: o.opLabel })),
		...(m.op !== undefined && !aggAt.some((o) => o.op === m.op)
			? [{ value: m.op, label: OP_LABEL[m.op] }]
			: [])
	]}
	{@const ofOptions = [
		...(m.field !== undefined && !mo.aggs.some((o) => aggFn(o) === m.q && aggOf(o) === m.field)
			? [
					{
						value: m.field,
						label: catalog[child]?.fields[m.field]?.label ?? humanize(m.field)
					}
				]
			: []),
		...[...new Set(mo.aggs.filter((o) => aggFn(o) === m.q).map((o) => aggOf(o)!))].map((f) => ({
			value: f,
			label: catalog[child]?.fields[f]?.label ?? humanize(f)
		}))
	]}
	<section
		class="filter-scope"
		role="group"
		aria-label={msg(bolt, 'view.relatedScope', 'Related records')}
		data-many={m.rel}
	>
		<div class="scope-header">
			{@render toggleScope()}
			<div class="scope-sentence">
				<Combobox
					variant="ghost"
					class="w-auto"
					aria-label={msg(bolt, 'view.quantifier', 'Quantifier')}
					value={m.q}
					options={quantOptions.map((q) => ({
						value: q,
						label: quantLabel(q)
					}))}
					onChange={(q) => {
						if (q !== null) commit(selectQuantifier(catalog, model, offers, prefix, m, q));
					}}
				/>
				{#if agg && m.q !== 'count'}
					<Combobox
						variant="ghost"
						class="w-auto"
						aria-label={msg(bolt, 'view.of', 'Of')}
						value={m.field ?? null}
						onChange={(f) => {
							if (f !== null) {
								const at = mo.aggs.filter((o) => aggFn(o) === m.q && aggOf(o) === f);
								onChange({
									...m,
									field: f,
									op: (at.some((o) => o.op === m.op) ? m.op : (at[0]?.op ?? 'gte')) as Cmp,
									n: aggregateValue(catalog, child, m.q, f, m.n)
								});
							}
						}}
						options={ofOptions}
					/>
				{/if}
				{#if agg && m.q !== 'count'}<span class="scope-tail">{msg(bolt, 'view.inScope', 'in')}</span
					>{/if}
				<FieldPicker {catalog} {model} {offers} {prefix} value={m.rel} many={top} onPick={picked} />
				{#if !agg && m.of.length > 0}<span class="scope-tail" data-many-heading
						>{msg(bolt, 'view.scope.matches', 'matches:')}</span
					>{/if}
				{#if agg}
					{@const aggregateKind =
						m.field === undefined ? undefined : catalog[child]?.fields[m.field]}
					<Combobox
						variant="ghost"
						class="w-auto"
						aria-label={msg(bolt, 'view.compare', 'Compare')}
						value={m.op ?? null}
						onChange={(op) => {
							if (op !== null) onChange({ ...m, op: op as Cmp });
						}}
						options={compareOptions}
					/>
					{#if aggregateKind?.kind === 'date' || aggregateKind?.kind === 'instant'}
						<div class="w-48">
							<Editor
								kind={{ ...aggregateKind, optional: true }}
								value={typeof m.n === 'string' ? m.n : null}
								name={m.field ?? 'date'}
								onChange={(value) =>
									onChange({ ...m, n: typeof value === 'string' ? value : null })}
							/>
						</div>
					{:else}<input
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
				{/if}
			</div>
			<div class="scope-actions">{@render addScope(m)}{@render remove()}</div>
		</div>
		{#if !agg}
			{@const at = manyAt(prefix, m.rel)}
			{@render nested(m, child, false, [
				...at.prefix,
				{ k: m.q as 'some' | 'every' | 'none', rel: at.name }
			])}
		{/if}
	</section>
{:else}
	{@const r = node.path === '' ? null : resolve(catalog, model, node.path)}
	{@const at = offersFor(offers, prefix, node.path)}
	<div class="condition-controls" data-cond={node.path}>
		<div class="flex min-w-0 flex-col gap-1">
			<span class="text-muted-foreground sr-only text-xs">{msg(bolt, 'view.field', 'Field')}</span>
			<FieldPicker
				{catalog}
				{model}
				{offers}
				{prefix}
				value={node.path}
				many={top}
				onPick={picked}
			/>
		</div>
		{#if r !== null}
			{@const c = node}
			{@const operands = operandsFor(r, c.op, variables).filter(
				(o) => o !== 'field' || fieldsFor(catalog, model, c.path).length > 0
			)}
			<div class="flex flex-col gap-1">
				<span class="text-muted-foreground sr-only text-xs"
					>{msg(bolt, 'view.operator', 'Operator')}</span
				>
				<Combobox
					variant="ghost"
					class="w-auto"
					aria-label={msg(bolt, 'view.operator', 'Operator')}
					value={c.op}
					onChange={(op) => {
						if (op !== null)
							commit(selectOperator(catalog, model, c, op, offers, prefix, variables));
					}}
					placeholder={msg(bolt, 'view.operator', 'Operator')}
					options={[
						...operatorsFor(offers, prefix, c.path, r).map((o) => ({
							value: o.op,
							label: o.label
						})),
						...(c.op === 'during' && !at.some((o) => o.op === 'during')
							? [
									{
										value: 'during' as const,
										label: msg(bolt, 'view.during', 'is within')
									}
								]
							: []),
						...(c.op === 'near' && !at.some((o) => o.op === 'near')
							? [{ value: 'near' as const, label: msg(bolt, 'view.near', 'is within') }]
							: [])
					]}
				/>
			</div>
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
				{@const presets =
					c.op === 'during' || c.op === 'like' ? [] : variablesFor(r, c.op, variables)}
				{@const named = variableOf(c.arg)}
				<div class="flex min-w-0 flex-col gap-1">
					<span class="text-muted-foreground sr-only text-xs"
						>{msg(bolt, 'view.value', 'Value')}</span
					>
					<!-- svelte-ignore a11y_no_static_element_interactions: it only listens for the `@` its controls receive -->
					<div
						class="relative flex flex-wrap items-center gap-1.5"
						data-value
						onkeydown={(e) => atKey(e, presets.length > 0 || variables !== undefined)}
					>
						{#if variable !== null}
							{@const matching = presets.filter((v) => v.name.startsWith(variable ?? ''))}
							<input
								class={cn(CONTROL, 'w-40')}
								type="text"
								role="combobox"
								aria-autocomplete="list"
								aria-expanded="true"
								aria-controls="filter-variables"
								aria-activedescendant={matching[variableActive] === undefined
									? undefined
									: `filter-variable-${variableActive}`}
								aria-label={msg(bolt, 'view.variable', 'Variable')}
								data-variable-input
								value={`@${variable}`}
								{@attach (el) => el.focus()}
								oninput={(e) => {
									variable = e.currentTarget.value.replace(/^@/, '');
									variableActive = 0;
								}}
								onkeydown={(e) => {
									e.stopPropagation();
									if (e.key === 'Escape') variable = null;
									else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
										if (matching.length === 0) return;
										e.preventDefault();
										variableActive = stepActive(
											matching.length,
											variableActive,
											e.key === 'ArrowDown' ? 1 : -1
										);
									} else if (
										e.key === 'Enter' &&
										(matching[variableActive] !== undefined ||
											varError(r, c.op, variable ?? '', variables) === undefined)
									) {
										e.preventDefault();
										setArg(
											matching[variableActive]?.arg ?? {
												_tag: 'var',
												var: variable ?? ''
											}
										);
										variable = null;
									}
								}}
								onblur={() => (variable = null)}
							/>
							<ul
								id="filter-variables"
								role="listbox"
								class="bg-popover absolute top-full left-0 z-50 mt-1 min-w-40 rounded-md border p-1 shadow-deep"
								data-variables
							>
								{#each matching as v, i (v.name)}
									<li
										id={`filter-variable-${i}`}
										role="option"
										aria-selected={i === variableActive}
										data-variable-option={v.name}
										data-active={i === variableActive ? 'true' : undefined}
									>
										<button
											type="button"
											class={cn(
												'hover:bg-muted w-full rounded-sm px-2 py-1 text-left text-sm',
												i === variableActive && 'bg-muted'
											)}
											onmousedown={(e) => e.preventDefault()}
											onmousemove={() => (variableActive = i)}
											onclick={() => {
												setArg(v.arg);
												variable = null;
											}}>@{v.name}</button
										>
									</li>
								{/each}
							</ul>
						{:else if draft !== null && c.arg !== null && 'var' in c.arg}
							{@const error = varError(r, c.op, draft, variables)}
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
										if (varError(r, c.op, next, variables) === undefined)
											setArg({ _tag: 'var', var: next });
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
								class="bg-muted inline-flex h-8 items-center gap-1 rounded-sm px-2.5 text-xs"
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

						{#if c.op === 'during'}
							{@const values = at.find((o) => o.op === 'during')?.values ?? []}
							<Combobox
								variant="ghost"
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
						{:else if variable !== null || (c.arg !== null && 'var' in c.arg)}
							<!-- the variable editor or chip owns the value position -->
						{:else if c.arg !== null && 'field' in c.arg}
							<Combobox
								variant="ghost"
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
										e.currentTarget.value === ''
											? null
											: { _tag: 'lit', lit: e.currentTarget.value }
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
										<span
											class="bg-muted inline-flex h-8 items-center gap-1 rounded-sm px-2.5 text-xs"
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
				</div>
			{/if}
			{#if !NO_VALUE.includes(c.op) && c.op !== 'during' && c.op !== 'like' && operands.length > 1}
				{@const lit =
					r.leaf === 'rel'
						? 'record'
						: r.kind.kind === 'date' || r.kind.kind === 'instant' || r.kind.kind === 'period'
							? 'date'
							: 'lit'}
				<Popover.Root bind:open={operandOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="rule-more text-muted-foreground hover:bg-muted grid place-items-center rounded-sm"
								aria-label={msg(bolt, 'view.operand', 'Compare with')}
								title={msg(bolt, 'view.operand', 'Compare with')}
								data-compare-with
							>
								<svg viewBox="0 0 24 24" class="size-3.5" fill="currentColor" aria-hidden="true"
									><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle
										cx="19"
										cy="12"
										r="1.5"
									/></svg
								>
							</button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content
						align="end"
						class="w-48 p-2"
						aria-label={msg(bolt, 'view.operand', 'Compare with')}
					>
						<Combobox
							variant="ghost"
							class="w-auto"
							aria-label={msg(bolt, 'view.operand', 'Compare with')}
							value={argKind(c.arg)}
							onChange={async (o) => {
								operandOpen = false;
								if (o === null || o === argKind(c.arg)) return;
								variable = null;
								draft = null;
								// Close the menu's focus scope before mounting the inline editor.
								await tick();
								setArg(operand(o, c.path));
							}}
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
					</Popover.Content>
				</Popover.Root>
			{/if}
		{/if}
		{@render remove()}
	</div>
{/if}

<style>
	.filter-scope {
		min-width: 0;
	}
	.scope-header {
		display: flex;
		align-items: flex-start;
		gap: 0.25rem;
		min-height: 1.75rem;
	}
	.scope-toggle {
		display: grid;
		place-items: center;
		flex: none;
		width: 1rem;
		height: 1.75rem;
		color: var(--color-muted-foreground);
		border-radius: 0.25rem;
	}
	.scope-toggle:hover,
	.scope-toggle:focus-visible {
		background: var(--color-muted);
		color: var(--color-foreground);
	}
	.scope-sentence {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		min-width: 0;
	}
	.scope-actions {
		display: flex;
		flex: none;
		align-items: center;
		gap: 0.125rem;
	}
	.literal-value {
		font-size: 0.75rem;
	}
	.scope-tail {
		font-size: 0.75rem;
		color: var(--color-muted-foreground);
	}
	.scope-body {
		margin-left: 0.5rem;
		padding-left: 0.75rem;
		border-left: 1px solid var(--color-border);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.scope-body[hidden] {
		display: none;
	}
	.scope-branch {
		position: relative;
		min-width: 0;
	}
	.scope-branch::before {
		content: '';
		position: absolute;
		left: -0.75rem;
		top: 0.875rem;
		width: 0.5rem;
		border-top: 1px solid var(--color-border);
	}
	.condition-controls {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem;
		min-height: 1.75rem;
		padding-right: 3rem;
	}
	.condition-controls > .rule-more {
		position: absolute;
		right: 1.5rem;
		top: 0;
		width: 1.5rem;
		height: 1.75rem;
	}
	.condition-controls > .filter-remove {
		position: absolute;
		right: 0;
		top: 0;
	}
	.filter-remove {
		width: 1.5rem;
		height: 1.75rem;
	}
	/* their 44px floors must not overlap: Remove sits on top, and a tap on Compare would delete the rule */
	@media (pointer: coarse) {
		.condition-controls {
			padding-right: 5.5rem;
		}
		.condition-controls > .rule-more {
			right: 2.75rem;
		}
	}
	@media (hover: hover) and (pointer: fine) {
		.rule-more,
		.filter-remove,
		.scope-actions {
			opacity: 0;
		}
		.condition-controls:hover .rule-more,
		.condition-controls:focus-within .rule-more,
		.condition-controls:hover > .filter-remove,
		.condition-controls:focus-within > .filter-remove,
		.scope-header:hover .scope-actions,
		.scope-header:focus-within .scope-actions,
		.scope-header:hover .filter-remove,
		.scope-header:focus-within .filter-remove {
			opacity: 1;
		}
	}
</style>
