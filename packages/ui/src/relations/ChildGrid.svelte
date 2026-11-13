<!--
@component
A related-record grid with explicit child operations, original revisions and parent or independent saves.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Json } from '../client/contract.js';
	import type { Page, Row, Values } from '../model/types.js';
	import type { Col } from '../table/Table.svelte';
	/** The parent model and inverse relation, with an explicit save scope and optional display columns/filter. */
	type ChildGridProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The parent model. */
		of: string;
		/** The parent's child relation whose records the grid lists. */
		relation: string;
		/** The parent record's id; unset (a new parent) reads no rows. */
		id?: string;
		/**
		 * `'parent'` (default): edits follow the enclosing record form's edit mode and save with the parent through its
		 * child contract. `'independent'`: the grid has its own Edit toggle and saves each child through the child model's
		 * own verbs.
		 */
		save?: 'parent' | 'independent';
		/** The child columns. Default: the contract's create and update columns, then every exposed field but the parent ref. */
		columns?: readonly Col<Row>[];
		/** A filter ANDed with the parent scope. */
		where?: Json;
	};
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { fork } from '../effect/index.js';
	import { getContext, onDestroy, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { watch as changes } from 'runed';
	import { fields_text, recordText } from '../kinds/kind.js';
	import { FormState, use_record_controller } from '../form/form-state.svelte.js';
	import { changed, formSpec, locked } from '../form/draft.js';
	import { pendingUnload } from '../form/unload.js';
	import type { ChildOperation } from '../form/child-operations.js';
	import { Button } from '../primitives/button/index.js';
	import { confirm_action } from '../primitives/dialog/confirm.js';
	import Picker from '../kinds/picker.svelte';
	import { bolt_of } from '../client/context.js';
	import { type Outcome } from '../client/contract.js';
	import { actOutcome } from '../actions/outcome.js';
	import { and } from '../filter/scope.js';
	import { msg, catalogText } from '../text/messages.js';
	import { by_id, first_of, page_of, request_json } from '../read/request.js';
	import { mapped, queryState } from '../read/state.js';
	import ReadGate from '../read/ReadGate.svelte';
	import Table from '../table/Table.svelte';
	import ChildCell from './ChildCell.svelte';
	let { ctx, of, relation, id, save = 'parent', columns, where }: ChildGridProps = $props();
	const bolt = $derived(bolt_of(ctx)),
		kinds = $derived(ctx.ui.kinds),
		scope = use_record_controller(),
		owner = scope?.current;
	const contract = $derived(owner?.spec.children?.[relation]);
	const identity = $derived(contract ?? kinds.catalog?.[of]?.children?.[relation]);
	const model = $derived(identity?.model ?? '');
	const exposure = $derived(kinds.catalog?.[model]);
	const strategy = $derived(
		{
			parent: {
				create: contract?.create,
				update: contract?.update,
				delete: contract?.delete === true,
				link: contract?.link === true,
				unlink: contract?.unlink === true
			},
			independent: {
				create: id === undefined ? undefined : exposure?.create,
				update: exposure?.update,
				delete: exposure?.delete === true,
				link: exposure?.update?.columns.includes(identity?.parent ?? '') === true,
				unlink: exposure?.relations?.[identity?.parent ?? '']?.optional === true
			}
		}[save]
	);
	const permits = (
		permission: { allowed?: boolean; writable?: boolean; proposal: boolean } | null | undefined
	) =>
		permission !== null &&
		permission !== undefined &&
		(permission.allowed === true || permission.writable === true || permission.proposal);
	const fields = $derived(
		columns === undefined
			? [
					...new Set([
						...(contract?.create?.columns ?? []),
						...(contract?.update?.columns ?? []),
						...Object.keys(exposure?.fields ?? {}).filter((name) => name !== identity?.parent)
					])
				]
			: columns
					.map((column) => (typeof column === 'string' ? column : column.field))
					.filter(
						(name) =>
							exposure?.fields[name] !== undefined || exposure?.relations?.[name] !== undefined
					)
	);
	let after = $state<string | null>(null),
		independentEdit = $state(false),
		link = $state<Json>(null),
		notice = $state<string | null>(null),
		noticeError = $state(true);
	const activeEdit = $derived(
		save === 'parent' ? owner?.mode === 'edit' || owner?.mode === 'create' : independentEdit
	);
	const editing = $derived(scope?.historical !== true && activeEdit);
	const reads = $derived(
		id === undefined || identity === undefined
			? null
			: mapped(
					bolt.query(
						request_json({
							[model]: {
								where: and(where, { [identity.parent]: id }),
								fields: [...new Set([...fields, identity.parent, 'revision'])],
								limit: 25,
								after: after ?? undefined
							}
						})
					),
					(answer) => page_of(answer, model)
				)
	);
	const loaded = $derived(queryState(reads));
	const rows = $derived(loaded.kind === 'ready' ? loaded.value.rows : []);
	type Draft = {
		form: FormState;
		row: Row;
		created: boolean;
		removed?: 'delete' | 'unlink';
		request: number;
	};
	const drafts = new SvelteMap<string, Draft>();
	let links = $state<ChildOperation[]>(
		untrack(
			() => owner?.children[relation]?.filter((operation) => operation.action === 'link') ?? []
		)
	);
	const linkedLabels = new SvelteMap<string, string>();
	let linkBusy = $state(false);
	let active = true;
	const text = $derived({
		pending_approval: msg(bolt, 'form.pending_approval'),
		conflict: msg(bolt, 'form.conflict'),
		unknown: msg(bolt, 'form.unknown'),
		running: msg(bolt, 'form.running')
	});
	onDestroy(() => {
		active = false;
	});
	untrack(() => {
		if (save !== 'parent' || owner === null || owner === undefined) return;
		for (const [key, form] of owner.child_forms) {
			if (!key.startsWith(`${relation}:`)) continue;
			const id = key.slice(relation.length + 1);
			const removed = owner.children[relation]?.find(
				(operation) =>
					(operation.action === 'delete' || operation.action === 'unlink') && operation.id === id
			);
			drafts.set(id, {
				form,
				row: { ...form.row, id },
				created: form.spec.target.of === 'model' && form.spec.target.mode === 'create',
				request: 0,
				...(removed?.action === 'delete' || removed?.action === 'unlink'
					? { removed: removed.action }
					: {})
			});
		}
		// a restored draft's created rows come back with it; otherwise a create form's values seed the first rows
		const already = [...owner.child_forms].some(
			([key, form]) =>
				key.startsWith(`${relation}:`) &&
				form.spec.target.of === 'model' &&
				form.spec.target.mode === 'create'
		);
		if (already) return;
		const persisted = owner.restored
			? (owner.children[relation] ?? []).flatMap((operation) =>
					operation.action === 'create' ? [operation.values] : []
				)
			: owner.child_seeds(relation);
		for (const [index, values] of persisted.entries()) {
			const key = `draft:restored:${index}`;
			const entry = make(
				{
					id: key,
					...(id === undefined || identity === undefined ? {} : { [identity.parent]: id }),
					...values
				},
				true,
				key
			);
			if (entry !== null) drafts.set(key, entry);
		}
	});
	onDestroy(() => {
		for (const entry of drafts.values()) entry.request++;
	});
	const dirty = $derived(
		linkBusy ||
			links.length > 0 ||
			[...drafts.values()].some(
				(entry) =>
					entry.created || entry.removed !== undefined || entry.form.dirty || entry.form.pending
			)
	);
	function make(row: Row, created: boolean, key = row.id): Draft | null {
		const target = created ? 'create' : 'update';
		const selected = strategy[target];
		const catalog =
			exposure === undefined
				? undefined
				: {
						...exposure,
						...(save === 'parent' && target === 'update' && selected === undefined
							? { update: { columns: [] } }
							: selected === undefined
								? {}
								: { [target]: selected })
					};
		const spec = formSpec(model, catalog, target, created ? undefined : row.id);
		if (spec === null) return null;
		const inherited =
			created && owner !== null && owner !== undefined
				? Object.fromEntries(
						Object.entries(exposure?.fields ?? {})
							.filter(
								([name, kind]) =>
									kind.kind === 'currency' &&
									owner.spec.fields.some(
										(field) => field.name === name && field.kind.kind === 'currency'
									)
							)
							.map(([name]) => [name, owner.get(name)])
					)
				: {};
		const form =
			save === 'parent'
				? (owner?.child_forms.get(`${relation}:${key}`) ??
					new FormState(
						spec,
						created ? null : row,
						created ? { ...inherited, ...row } : {},
						(acts, options) => bolt.act(acts, options),
						text,
						(field) => locked(exposure?.fields ?? {}, row, exposure?.locks)(field),
						undefined,
						created ? undefined : owner?.child_storage_key(relation, key)
					))
				: new FormState(
						spec,
						created ? null : row,
						created ? { ...inherited, ...row } : {},
						(acts, options) => bolt.act(acts, options),
						text,
						(field) => locked(exposure?.fields ?? {}, row, exposure?.locks)(field)
					);
		if (save === 'parent') owner?.child_forms.set(`${relation}:${key}`, form);
		form.mode = created ? 'create' : activeEdit ? 'edit' : 'view';
		if (save === 'independent')
			form.on_outcome((outcome) => {
				noticeError =
					outcome.kind === 'refused' || outcome.kind === 'conflict' || outcome.kind === 'unknown';
				notice =
					outcome.kind === 'pending_approval'
						? text.pending_approval
						: outcome.kind === 'refused'
							? outcome.message
							: outcome.kind === 'committed'
								? null
								: outcome.kind === 'running'
									? text.running
									: text.conflict;
			});
		return { form, row, created, request: 0 };
	}
	const parentContext = () =>
		save === 'parent' &&
		owner?.spec.target.of === 'model' &&
		owner.spec.target.mode === 'update' &&
		owner.spec.target.id !== undefined &&
		owner.revision !== undefined
			? { model: of, id: owner.spec.target.id, relation, revision: owner.revision }
			: undefined;
	function permissions(entry: Draft, row: Row): void {
		if (bolt.record_capabilities === undefined) return;
		const request = ++entry.request;
		entry.form.expect_capabilities();
		fork(
			bolt.record_capabilities(model, row.id, parentContext()).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (request !== entry.request) return;
						if (
							value !== null &&
							(value.id !== row.id || value.model !== model || value.revision !== row['revision'])
						) {
							notice = text.conflict;
							return;
						}
						entry.form.capabilities = value;
					})
				)
			),
			() => {
				if (request === entry.request)
					notice = msg(bolt, 'record.permissionsFailed');
			}
		);
	}

	changes([() => rows, () => owner?.capabilities?.revision, () => owner?.revision], () => {
		for (const row of rows) {
			const key = row.id,
				entry = drafts.get(key) ?? make(row, false);
			if (entry === null) continue;
			entry.form.refresh(row);
			const removal = owner?.children[relation]?.find(
				(operation) =>
					(operation.action === 'delete' || operation.action === 'unlink') && operation.id === key
			);
			drafts.set(
				key,
				removal?.action === 'delete' || removal?.action === 'unlink'
					? { ...entry, removed: removal.action }
					: entry
			);
			void permissions(entry, row);
		}
	});
	changes(
		() => activeEdit,
		() => {
			for (const entry of drafts.values())
				if (!entry.created) {
					if (activeEdit) entry.form.edit();
					else entry.form.view();
				}
		}
	);
	function commands(): ChildOperation[] {
		return [
			...links,
			...[...drafts].flatMap(([key, entry]): ChildOperation[] => {
				if (entry.created)
					return [
						{
							action: 'create',
							values: Object.fromEntries(
								Object.entries(entry.form.values).filter(([, value]) => value !== null)
							),
							...(entry.form.requesting_approval ? { proposal: true as const } : {})
						}
					];
				const revision = entry.form.revision;
				if (revision === undefined) return [];
				if (entry.removed !== undefined) {
					const capability =
						entry.removed === 'delete'
							? entry.form.capabilities?.delete
							: entry.form.capabilities?.fields[identity?.parent ?? ''];
					const proposal =
						capability?.proposal === true &&
						('allowed' in capability ? !capability.allowed : !capability.writable);
					return [
						{
							action: entry.removed,
							id: key,
							revision,
							...(proposal ? { proposal: true as const } : {})
						}
					];
				}
				const set = changed(entry.form.base, entry.form.values);
				return Object.keys(set).length === 0
					? []
					: [
							{
								action: 'update',
								id: key,
								revision,
								set,
								...(entry.form.requesting_approval ? { proposal: true as const } : {})
							}
						];
			})
		];
	}
	changes(
		() => [
			links,
			[...drafts].map(([key, entry]) => [key, entry.removed, { ...entry.form.values }])
		],
		() => {
			if (save === 'parent' && owner !== null && owner !== undefined && contract !== undefined)
				owner.queue_children(relation, commands());
		}
	);
	function reset() {
		links = [];
		linkedLabels.clear();
		for (const [key, entry] of drafts) {
			if (entry.created) drafts.delete(key);
			else {
				entry.form.reset();
				drafts.set(key, {
					form: entry.form,
					row: entry.row,
					created: false,
					request: entry.request
				});
			}
		}
	}
	if (owner !== null && owner !== undefined && untrack(() => save) === 'parent') {
		onDestroy(owner.on_reset(reset));
		onDestroy(
			owner.before_submit(() =>
				Effect.gen(function* () {
					const valid = yield* Effect.forEach(
						[...drafts.values()],
						(entry) => {
							if (entry.removed !== undefined && bolt.record_capabilities !== undefined) {
								const capability =
									entry.removed === 'delete'
										? entry.form.capabilities?.delete
										: entry.form.capabilities?.fields[identity?.parent ?? ''];
								return Effect.succeed(permits(capability));
							}
							return entry.form.dirty || entry.created
								? entry.form.prepare()
								: Effect.succeed(true);
						},
						{ concurrency: 'unbounded' }
					);
					owner.queue_children(relation, commands());
					if (valid.some((value) => !value))
						notice = msg(bolt, 'child.reviewDraft');
					return valid.every(Boolean);
				})
			)
		);
		onDestroy(
			owner.before_outcome((outcome) => {
				if (outcome.kind === 'committed' || outcome.kind === 'pending_approval') {
					for (const entry of drafts.values()) entry.form.accept(outcome);
					reset();
				}
			})
		);
	}
	const displayed = $derived<readonly Row[]>([
		...rows
			.filter((row) => drafts.get(row.id)?.removed === undefined)
			.map((row) => (drafts.has(row.id) ? { ...drafts.get(row.id)?.form.row, id: row.id } : row)),
		...[...drafts].flatMap(([key, entry]) =>
			entry.created ? [{ ...entry.form.values, id: key }] : []
		)
	]);
	function add() {
		if (identity === undefined) return;
		const key = `draft:${crypto.randomUUID()}`,
			entry = make({ id: key, ...(id === undefined ? {} : { [identity.parent]: id }) }, true, key);
		if (entry !== null) {
			drafts.set(key, entry);
			if (save === 'independent')
				entry.form.on_outcome((outcome) => {
					if (outcome.kind === 'committed' || outcome.kind === 'pending_approval')
						drafts.delete(key);
				});
		}
	}
	function remove(key: string, action: 'delete' | 'unlink') {
		const entry = drafts.get(key);
		if (entry === undefined || entry.form.pending || (save === 'parent' && owner?.pending)) return;
		if (entry.created) {
			drafts.delete(key);
			return;
		}
		if (save === 'parent') {
			drafts.set(key, { ...entry, removed: action });
			return;
		}
		if (identity === undefined || entry.form.revision === undefined) return;
		entry.form.pending = true;
		fork(
			actOutcome(
				bolt.act(
					{ [`${model}.${action === 'delete' ? 'delete' : 'update'}`]: action === 'delete'
						? [{ target: { id: key, revision: entry.form.revision } }]
						: [{ target: { id: key, revision: entry.form.revision }, set: { [identity.parent]: null } }] }
				)
			).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						if (outcome.kind === 'committed') drafts.set(key, { ...entry, removed: action });
						else if (outcome.kind === 'pending_approval' || outcome.kind === 'running') {
							noticeError = false;
							notice = outcome.kind === 'running' ? text.running : text.pending_approval;
						} else {
							noticeError = true;
							notice = outcome.kind === 'refused' ? outcome.message : text.conflict;
						}
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						entry.form.pending = false;
					})
				)
			),
			(error) => {
				noticeError = true;
				notice = bolt.t(error.message);
			}
		);
	}
	function linkRow() {
		if (
			linkBusy ||
			owner?.pending ||
			typeof link !== 'string' ||
			identity === undefined ||
			(save === 'independent' && id === undefined)
		)
			return;
		const selected = link;
		linkBusy = true;
		fork(
			Effect.gen(function* () {
				const row = first_of(yield* bolt.query(by_id(model, selected)), model);
				if (!active) return;
				if (row === null || typeof row['revision'] !== 'number') {
					notice = msg(bolt, 'record.not_found');
					return;
				}
				const capabilities =
					bolt.record_capabilities === undefined
						? undefined
						: yield* bolt.record_capabilities(model, selected, parentContext());
				if (!active) return;
				if (
					capabilities !== undefined &&
					capabilities !== null &&
					(capabilities.id !== selected ||
						capabilities.model !== model ||
						capabilities.revision !== row['revision'])
				) {
					notice = text.conflict;
					return;
				}
				const writable = capabilities?.fields[identity.parent];
				if (capabilities !== undefined && !writable?.writable && !writable?.proposal) {
					notice = msg(bolt, 'record.noAccess');
					return;
				}
				if (row[identity.parent] != null) {
					notice = msg(bolt, 'child.alreadyLinked');
					return;
				}
				if (save === 'parent' && owner !== null && owner !== undefined) {
					linkedLabels.set(
						selected,
						(exposure?.record_label !== undefined
							? recordText(exposure, row)
							: fields_text(
									exposure?.fields ?? {},
									row,
									(exposure?.label ?? []).filter(
										(name) =>
											capabilities === undefined ||
											(capabilities !== null && Object.hasOwn(capabilities.fields, name))
									)
								)) || selected
					);
					links = [
						...links.filter(
							(operation) => operation.action === 'create' || operation.id !== selected
						),
						{
							action: 'link',
							id: selected,
							revision: row['revision'],
							...(writable?.writable !== true && writable?.proposal === true
								? { proposal: true as const }
								: {})
						}
					];
				} else {
					if (id === undefined) return;
					const outcome = yield* actOutcome(
						bolt.act({ [`${model}.update`]: [{ target: row, set: { [identity.parent]: id } }] })
					);
					if (outcome.kind !== 'committed' && outcome.kind !== 'pending_approval')
						notice =
							outcome.kind === 'refused'
								? outcome.message
								: outcome.kind === 'running'
									? text.running
									: text.conflict;
				}
				link = null;
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						noticeError = true;
						notice = bolt.t(error.message);
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						linkBusy = false;
					})
				)
			)
		);
	}
	const beforeUnload = pendingUnload(() => save === 'independent' && dirty);
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#snippet cell({ field: name, row }: { field: string; row: Row })}
	{@const entry = drafts.get(row.id)}
	{#if entry !== undefined}<ChildCell {ctx}
			form={entry.form}
			{name}
			readonly={!editing}
			disabled={save === 'parent' && owner?.pending === true}
			pending_permissions={!entry.created &&
				bolt.record_capabilities !== undefined &&
				entry.form.capabilities === undefined}
		/>{/if}
{/snippet}
{#snippet operations({ row }: { row: Row })}
	{@const key = row.id}
	{@const entry = drafts.get(key)}
	{#if entry !== undefined}
		<div class="flex flex-wrap gap-1">
			{#if editing}
				{#if entry.created || entry.form.dirty}<Button
						disabled={!entry.form.can_save}
						onclick={() => fork(entry.form.submit())}
						>{entry.form.resubmitting
							? msg(bolt, 'record.resubmit')
							: entry.form.requesting_approval
								? msg(bolt, 'record.requestApproval')
								: msg(bolt, 'record.save')}</Button
					>{/if}
				{#if entry.created || (strategy.delete && permits(entry.form.capabilities?.delete))}<Button
						variant="ghost"
						disabled={entry.form.pending || owner?.pending === true}
						onclick={() => remove(key, 'delete')}>{msg(bolt, 'child.delete')}</Button
					>{/if}
				{#if !identity?.owned && strategy.unlink && permits(entry.form.capabilities?.fields[identity?.parent ?? ''])}<Button
						variant="ghost"
						disabled={entry.form.pending || owner?.pending === true}
						onclick={() => remove(key, 'unlink')}>{msg(bolt, 'child.unlink')}</Button
					>{/if}
			{/if}
		</div>
	{/if}
{/snippet}
{#snippet removeControl(row: Row)}
	{@const entry = drafts.get(row.id)}
	{@const action: 'delete' | 'unlink' | null =
		entry === undefined
			? null
			: entry.created
				? 'delete'
				: !identity?.owned &&
					  strategy.unlink &&
					  permits(entry.form.capabilities?.fields[identity?.parent ?? ''])
					? 'unlink'
					: strategy.delete && permits(entry.form.capabilities?.delete)
						? 'delete'
						: null}
	{#if editing && entry !== undefined && action !== null}
		<Button
			variant="ghost"
			size="icon"
			aria-label={action === 'delete'
				? msg(bolt, 'child.delete')
				: msg(bolt, 'child.unlink')}
			disabled={entry.form.pending || owner?.pending === true}
			onclick={() => remove(row.id, action)}
		>
			<Icon icon="lucide:x" class="size-3.5" aria-hidden="true" />
			<span class="sr-only"
				>{action === 'delete'
					? msg(bolt, 'child.delete')
					: msg(bolt, 'child.unlink')}</span
			>
		</Button>
	{/if}
{/snippet}

{#snippet table()}
	<Table {ctx}
		of={displayed}
		layout="grid"
		toolbar={false}
		row_trailing={save === 'parent' ? removeControl : undefined}
		columns={[
			...(columns ?? fields).map((column) =>
				typeof column === 'string'
					? { field: column, cell }
					: { ...column, cell: column.cell ?? cell }
			),
			...(save === 'independent'
				? [
						{
							field: '__operations',
							label: msg(bolt, 'child.actions'),
							cell: operations
						}
					]
				: [])
		]}
	/>
{/snippet}

<section class="grid min-w-0 gap-3" data-child-grid={relation} data-save-scope={save}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h3 class="font-medium">
			{catalogText(bolt, `field.${of}.${relation}`, relation.replaceAll('_', ' '))}
		</h3>
		{#if save === 'independent' && !scope?.historical}<Button
				variant="outline"
				disabled={linkBusy || [...drafts.values()].some((entry) => entry.form.pending)}
				onclick={() => {
					const toggle = () => {
						if (independentEdit) reset();
						independentEdit = !independentEdit;
					};
					if (!independentEdit || ![...drafts.values()].some((entry) => entry.form.dirty))
						return toggle();
					fork(
						confirm_action({
							title: msg(bolt, 'form.discardDraft'),
							confirm_label: msg(bolt, 'form.discard'),
							cancel_label: msg(bolt, 'record.cancel'),
							destructive: true
						}).pipe(
							Effect.tap((confirmed) =>
								Effect.sync(() => {
									if (confirmed) toggle();
								})
							)
						)
					);
				}}
				>{independentEdit
					? msg(bolt, 'record.cancel')
					: msg(bolt, 'record.edit')}</Button
			>{/if}
	</div>
	{#if identity === undefined}<p class="text-meta">
			{msg(bolt, 'child.unavailable')}
		</p>
	{:else}
		{#if id !== undefined}<ReadGate {ctx} state={loaded} what={model}>{@render table()}</ReadGate
			>{:else}{@render table()}{/if}
		{#if editing && strategy.create !== undefined}<div>
				<Button
					variant="ghost"
					disabled={save === 'parent' && owner?.pending === true}
					onclick={add}
				>
					<Icon icon="lucide:plus" class="size-3.5" aria-hidden="true" />
					{msg(bolt, 'child.add')}
				</Button>
			</div>{/if}
		{#if loaded.kind === 'ready' && loaded.value.next !== null}<Button
				variant="outline"
				onclick={() => {
					if (loaded.kind === 'ready' && loaded.value.next !== null) after = loaded.value.next;
				}}>{msg(bolt, 'child.next')}</Button
			>{/if}
		{#if editing && !identity.owned && strategy.link && (id !== undefined || (save === 'parent' && owner?.mode === 'create'))}<div
				class="flex items-center gap-2"
			>
				<Picker {ctx}
					of={model}
					value={typeof link === 'string' ? link : null}
					disabled={linkBusy || owner?.pending === true}
					on_change={(value) => {
						link = value;
					}}
				/><Button
					variant="outline"
					disabled={typeof link !== 'string' || linkBusy || owner?.pending === true}
					onclick={linkRow}>{msg(bolt, 'child.link')}</Button
				>
			</div>{/if}
	{/if}
	{#if save === 'parent'}
		{#each links as operation}{#if operation.action !== 'create'}<p class="text-meta" role="status">
					{msg(bolt, 'child.linkPending', {
						record: linkedLabels.get(operation.id) ?? msg(bolt, 'child.record')
					})}
				</p>{/if}{/each}
		{#each [...drafts] as [key, entry]}{#if entry.removed}<p class="text-meta" role="status">
					{catalogText(
						bolt,
						entry.removed === 'delete' ? 'child.deletePending' : 'child.unlinkPending',
						entry.removed === 'delete'
							? 'A row will be deleted when the parent saves.'
							: 'A row will be unlinked when the parent saves.'
					)}
				</p>{/if}{/each}
	{/if}
	{#if notice}<p
			role={noticeError ? 'alert' : 'status'}
			class={noticeError ? 'text-destructive text-sm' : 'text-meta'}
		>
			{notice}
		</p>{/if}
	{#if scope?.historical}<p class="text-meta">
			{dirty
				? msg(bolt, 'child.retainedDrafts'
					)
				: msg(bolt, 'child.currentRows'
					)}
		</p>{/if}
</section>
