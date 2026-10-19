<!--
@component
A related-record grid with explicit child operations, original revisions and parent or independent saves.
-->
<script lang="ts" module>
	import type { Json } from '../client/contract.js';
	import type { Row, Values } from '../collection/types.js';
	import type { Col } from '../table/Table.svelte';
	/** The parent collection and inverse relation, with an explicit save scope and optional display columns/filter. */
	export type ChildGridProps = {
		of: string;
		relation: string;
		id?: string;
		save?: 'parent' | 'independent';
		columns?: readonly Col<Row>[];
		where?: Json;
	};
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import { fork } from '../effect/index.js';
	import { getContext, onDestroy, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { watch as changes } from 'runed';
	import { useKinds } from '../kinds/context.js';
	import { fieldsText } from '../kinds/kind.js';
	import { FormState, useRecordController } from '../form/form-state.svelte.js';
	import { changed, formSpec, locked } from '../form/draft.js';
	import type { ChildOperation } from '../form/child-operations.js';
	import { Button } from '../primitives/button/index.js';
	import { SHEET_GUARD, type SheetGuard } from '../primitives/sheet/dismiss.js';
	import Picker from '../kinds/picker.svelte';
	import { openRecord } from '../record/navigation.js';
	import { useBolt } from '../client/context.js';
	import { type Outcome } from '../client/contract.js';
	import { actOutcome } from '../actions/outcome.js';
	import { and } from '../filter/scope.js';
	import { isRow, rowsOf } from '../read/results.js';
	import { msg } from '../text/messages.js';
	import { selectOf } from './select.js';
	import { watch } from '../read/live.svelte.js';
	import ReadGate from '../read/ReadGate.svelte';
	import Table from '../table/Table.svelte';
	import ChildCell from './ChildCell.svelte';
	let { of, relation, id, save = 'parent', columns, where }: ChildGridProps = $props();
	const bolt = useBolt(),
		kinds = useKinds(),
		scope = useRecordController(),
		owner = scope?.current;
	const contract = $derived(owner?.spec.children?.[relation]);
	const identity = $derived(contract ?? kinds.catalog?.[of]?.children?.[relation]);
	const collection = $derived(identity?.collection ?? '');
	const exposure = $derived(kinds.catalog?.[collection]);
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
	const reads = watch(() =>
		id === undefined || identity === undefined
			? null
			: bolt.live(
					bolt.read(collection, {
						where: and(where, { [identity.parent]: id }) ?? null,
						select: selectOf([...fields, identity.parent, 'revision']),
						limit: 25,
						...(after === null ? {} : { after })
					})
				)
	);
	const rows = $derived(reads.state.kind === 'ready' ? rowsOf(reads.state.value) : []);
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
	onDestroy(() => {
		active = false;
	});
	untrack(() => {
		if (save !== 'parent' || owner === null || owner === undefined) return;
		for (const [key, form] of owner.childForms) {
			if (!key.startsWith(`${relation}:`)) continue;
			const id = key.slice(relation.length + 1);
			const removed = owner.children[relation]?.find(
				(operation) =>
					(operation.action === 'delete' || operation.action === 'unlink') && operation.id === id
			);
			drafts.set(id, {
				form,
				row: { ...form.row, id },
				created: form.spec.target.of === 'collection' && form.spec.target.mode === 'create',
				request: 0,
				...(removed?.action === 'delete' || removed?.action === 'unlink'
					? { removed: removed.action }
					: {})
			});
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
	onDestroy(
		getContext<SheetGuard | undefined>(SHEET_GUARD)?.(() => save === 'independent' && dirty) ??
			(() => {})
	);
	const text = {
		pendingApproval: msg(bolt, 'form.pendingApproval', 'Pending approval'),
		conflict: msg(bolt, 'form.conflict', 'The record changed. Review your draft and try again.'),
		unknown: msg(bolt, 'form.unknown', 'The outcome is unknown. Retry to check the same request.')
	};
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
		const spec = formSpec(collection, catalog, target, created ? undefined : row.id);
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
				? (owner?.childForms.get(`${relation}:${key}`) ??
					new FormState(
						spec,
						created ? null : row,
						created ? { ...inherited, ...row } : {},
						(callable, input, options) => bolt.act(callable, input, options),
						text,
						(field) => locked(exposure?.fields ?? {}, row)(field)
					))
				: new FormState(
						spec,
						created ? null : row,
						created ? { ...inherited, ...row } : {},
						(callable, input, options) => bolt.act(callable, input, options),
						text,
						(field) => locked(exposure?.fields ?? {}, row)(field)
					);
		if (save === 'parent') owner?.childForms.set(`${relation}:${key}`, form);
		form.mode = created ? 'create' : activeEdit ? 'edit' : 'view';
		if (save === 'independent')
			form.onOutcome((outcome) => {
				noticeError =
					outcome.kind === 'refused' || outcome.kind === 'conflict' || outcome.kind === 'unknown';
				notice =
					outcome.kind === 'pendingApproval'
						? text.pendingApproval
						: outcome.kind === 'refused'
							? outcome.message
							: outcome.kind === 'committed'
								? null
								: text.conflict;
			});
		return { form, row, created, request: 0 };
	}
	const parentContext = () =>
		save === 'parent' &&
		owner?.spec.target.of === 'collection' &&
		owner.spec.target.mode === 'update' &&
		owner.spec.target.id !== undefined &&
		owner.revision !== undefined
			? { collection: of, id: owner.spec.target.id, relation, revision: owner.revision }
			: undefined;
	function permissions(entry: Draft, row: Row): void {
		if (bolt.recordCapabilities === undefined) return;
		const request = ++entry.request;
		entry.form.expectCapabilities();
		fork(
			bolt.recordCapabilities(collection, row.id, parentContext()).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						if (request !== entry.request) return;
						if (
							value !== null &&
							(value.id !== row.id ||
								value.collection !== collection ||
								value.revision !== row['revision'])
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
					notice = msg(bolt, 'record.permissionsFailed', 'Record permissions could not be loaded.');
			}
		);
	}

	changes([() => rows, () => owner?.capabilities?.revision, () => owner?.revision], () => {
		for (const row of rows) {
			const key = row.id,
				entry = drafts.get(key) ?? make(row, false);
			if (entry === null) continue;
			entry.form.refresh(row);
			drafts.set(key, entry);
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
							...(entry.form.requestingApproval ? { proposal: true as const } : {})
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
								...(entry.form.requestingApproval ? { proposal: true as const } : {})
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
				owner.queueChildren(relation, commands());
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
		onDestroy(owner.onReset(reset));
		onDestroy(
			owner.beforeSubmit(() =>
				Effect.gen(function* () {
					const valid = yield* Effect.forEach(
						[...drafts.values()],
						(entry) => {
							if (entry.removed !== undefined && bolt.recordCapabilities !== undefined) {
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
					owner.queueChildren(relation, commands());
					if (valid.some((value) => !value))
						notice = msg(bolt, 'child.reviewDraft', 'Review the related rows before saving.');
					return valid.every(Boolean);
				})
			)
		);
		onDestroy(
			owner.beforeOutcome((outcome) => {
				if (outcome.kind === 'committed' || outcome.kind === 'pendingApproval') {
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
				entry.form.onOutcome((outcome) => {
					if (outcome.kind === 'committed' || outcome.kind === 'pendingApproval')
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
					`${collection}.${action === 'delete' ? 'delete' : 'update'}`,
					action === 'delete' ? { target: key } : { target: key, set: { [identity.parent]: null } },
					{ observed: { [key]: entry.form.revision } }
				)
			).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						if (outcome.kind === 'committed') drafts.set(key, { ...entry, removed: action });
						else if (outcome.kind === 'pendingApproval') {
							noticeError = false;
							notice = text.pendingApproval;
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
			)
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
				const row = yield* bolt.get<Row | null>(collection, selected);
				if (!active) return;
				if (row === null || typeof row['revision'] !== 'number') {
					notice = msg(bolt, 'record.notFound', 'Not found or no access');
					return;
				}
				const capabilities =
					bolt.recordCapabilities === undefined
						? undefined
						: yield* bolt.recordCapabilities(collection, selected, parentContext());
				if (!active) return;
				if (
					capabilities !== undefined &&
					capabilities !== null &&
					(capabilities.id !== selected ||
						capabilities.collection !== collection ||
						capabilities.revision !== row['revision'])
				) {
					notice = text.conflict;
					return;
				}
				const writable = capabilities?.fields[identity.parent];
				if (capabilities !== undefined && !writable?.writable && !writable?.proposal) {
					notice = msg(bolt, 'record.noAccess', 'No access');
					return;
				}
				if (row[identity.parent] != null) {
					notice = msg(bolt, 'child.alreadyLinked', 'This record already has a parent.');
					return;
				}
				if (save === 'parent' && owner !== null && owner !== undefined) {
					linkedLabels.set(
						selected,
						fieldsText(
							exposure?.fields ?? {},
							row,
							(exposure?.label ?? []).filter(
								(name) =>
									capabilities === undefined ||
									(capabilities !== null && Object.hasOwn(capabilities.fields, name))
							)
						) || msg(bolt, 'child.record', 'Record')
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
						bolt.act(
							`${collection}.update`,
							{ target: selected, set: { [identity.parent]: id } },
							{ observed: { [selected]: row['revision'] } }
						)
					);
					if (outcome.kind !== 'committed' && outcome.kind !== 'pendingApproval')
						notice = outcome.kind === 'refused' ? outcome.message : text.conflict;
				}
				link = null;
			}).pipe(
				Effect.catch(() =>
					Effect.sync(() => {
						noticeError = true;
						notice = msg(bolt, 'child.saveFailed', 'The row could not be saved. Try again.');
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
	function beforeUnload(event: BeforeUnloadEvent) {
		if (save === 'independent' && dirty) {
			event.preventDefault();
			event.returnValue = true;
		}
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#snippet cell({ field: name, row }: { field: string; row: Row })}
	{@const entry = drafts.get(row.id)}
	{#if entry !== undefined}<ChildCell
			form={entry.form}
			{name}
			readonly={!editing}
			disabled={save === 'parent' && owner?.pending === true}
			pendingPermissions={!entry.created &&
				bolt.recordCapabilities !== undefined &&
				entry.form.capabilities === undefined}
		/>{/if}
{/snippet}
{#snippet operations({ row }: { row: Row })}
	{@const key = row.id}
	{@const entry = drafts.get(key)}
	{#if entry !== undefined}
		<div class="flex flex-wrap gap-1">
			{#if !entry.created}<Button
					size="sm"
					variant="ghost"
					onclick={() => openRecord(collection, key)}>{msg(bolt, 'child.open', 'Open')}</Button
				>{/if}
			{#if editing}
				{#if save === 'independent' && (entry.created || entry.form.dirty)}<Button
						size="sm"
						disabled={entry.form.pending || !entry.form.canSubmit}
						onclick={() => fork(entry.form.submit())}
						>{entry.form.requestingApproval
							? msg(bolt, 'record.requestApproval', 'Request approval')
							: msg(bolt, 'record.save', 'Save')}</Button
					>{/if}
				{#if entry.created || (strategy.delete && permits(entry.form.capabilities?.delete))}<Button
						size="sm"
						variant="ghost"
						disabled={entry.form.pending || (save === 'parent' && owner?.pending === true)}
						onclick={() => remove(key, 'delete')}>{msg(bolt, 'child.delete', 'Delete row')}</Button
					>{/if}
				{#if !identity?.owned && strategy.unlink && permits(entry.form.capabilities?.fields[identity?.parent ?? ''])}<Button
						size="sm"
						variant="ghost"
						disabled={entry.form.pending || (save === 'parent' && owner?.pending === true)}
						onclick={() => remove(key, 'unlink')}>{msg(bolt, 'child.unlink', 'Unlink')}</Button
					>{/if}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet table()}
	<Table
		of={displayed}
		layout="grid"
		columns={[
			...(columns ?? fields).map((column) =>
				typeof column === 'string'
					? { field: column, cell }
					: { ...column, cell: column.cell ?? cell }
			),
			{ field: '__operations', label: msg(bolt, 'child.actions', 'Actions'), cell: operations }
		]}
		onOpen={(row) => {
			if (!row.id.startsWith('draft:')) openRecord(collection, row.id);
		}}
	/>
{/snippet}

<section class="grid min-w-0 gap-3" data-child-grid={relation} data-save-scope={save}>
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<h3 class="font-medium">
				{msg(bolt, `field.${of}.${relation}`, relation.replaceAll('_', ' '))}
			</h3>
			<p class="text-meta">
				{save === 'parent'
					? msg(bolt, 'child.parentSave', 'Changes save with the parent.')
					: msg(bolt, 'child.independentSave', 'Each row saves independently.')}
			</p>
		</div>
		{#if save === 'independent' && !scope?.historical}<Button
				size="sm"
				variant="outline"
				disabled={linkBusy || [...drafts.values()].some((entry) => entry.form.pending)}
				onclick={() => {
					if (
						independentEdit &&
						[...drafts.values()].some((entry) => entry.form.dirty) &&
						!confirm(msg(bolt, 'form.discardDraft', 'Discard unsaved changes?'))
					)
						return;
					if (independentEdit) reset();
					independentEdit = !independentEdit;
				}}
				>{independentEdit
					? msg(bolt, 'record.cancel', 'Cancel')
					: msg(bolt, 'record.edit', 'Edit')}</Button
			>{/if}
		{#if editing && strategy.create !== undefined}<Button
				size="sm"
				variant="outline"
				disabled={save === 'parent' && owner?.pending === true}
				onclick={add}>{msg(bolt, 'child.add', 'Add row')}</Button
			>{/if}
	</div>
	{#if identity === undefined}<p class="text-meta">
			{msg(bolt, 'child.unavailable', 'This relationship is not exposed.')}
		</p>
	{:else}
		{#if id !== undefined}<ReadGate state={reads.state} what={collection}
				>{@render table()}</ReadGate
			>{:else}{@render table()}{/if}
		{#if reads.state.kind === 'ready' && isRow(reads.state.value) && typeof reads.state.value['next'] === 'string'}<Button
				size="sm"
				variant="outline"
				onclick={() => {
					if (
						reads.state.kind === 'ready' &&
						isRow(reads.state.value) &&
						typeof reads.state.value['next'] === 'string'
					)
						after = reads.state.value['next'];
				}}>{msg(bolt, 'child.next', 'Next page')}</Button
			>{/if}
		{#if editing && !identity.owned && strategy.link && (id !== undefined || (save === 'parent' && owner?.mode === 'create'))}<div
				class="flex items-center gap-2"
			>
				<Picker
					of={collection}
					value={typeof link === 'string' ? link : null}
					disabled={linkBusy || owner?.pending === true}
					onChange={(value) => {
						link = value;
					}}
				/><Button
					size="sm"
					variant="outline"
					disabled={typeof link !== 'string' || linkBusy || owner?.pending === true}
					onclick={linkRow}>{msg(bolt, 'child.link', 'Link existing')}</Button
				>
			</div>{/if}
	{/if}
	{#if save === 'parent'}
		{#if contract?.update === undefined}<p class="text-meta">
				{msg(bolt, 'child.reviewActions', 'Open a child record to review its available actions.')}
			</p>{/if}
		{#each links as operation}{#if operation.action !== 'create'}<p class="text-meta" role="status">
					{msg(bolt, 'child.linkPending', 'Will link {record}.', {
						record: linkedLabels.get(operation.id) ?? msg(bolt, 'child.record', 'Record')
					})}
				</p>{/if}{/each}
		{#each [...drafts] as [key, entry]}{#if entry.removed}<p class="text-meta" role="status">
					{msg(
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
				? msg(
						bolt,
						'child.retainedDrafts',
						'Related row drafts are preserved. Return to the current revision to continue editing.'
					)
				: msg(
						bolt,
						'child.currentRows',
						'Related rows show their current values. Return to the current revision to edit.'
					)}
		</p>{/if}
</section>
