<script lang="ts">
	// The mounted draft: built once its row is known, and handed to every `Field` below by context.
	import { fork, query } from '../effect/index.js';
	import { getContext, onDestroy, untrack, type Snippet } from 'svelte';
	import { watch } from 'runed';
	import { SHEET_GUARD, type SheetGuard } from '../primitives/sheet/dismiss.js';
	import Alert from '../primitives/alert/alert.svelte';
	import Button from '../primitives/button/button.svelte';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { provideControls, uiText } from '../primitives/utils.js';
	import type { Fields } from '../kinds/kind.js';
	import { locked, type FormSpec, type Outcome, type Row } from './draft.js';
	import Field from './field.svelte';
	import Grid from '../layout/grid.svelte';
	import Section, { groupSections, type RecordSection } from './section.svelte';
	import { useBolt } from '../client/context.js';
	import { msg } from '../text/messages.js';
	import { FormState, provideForm, useRecordController, type Act } from './form-state.svelte.js';

	let {
		spec,
		record,
		values,
		modelFields,
		act,
		fields,
		sections,
		submit,
		readonly: asked,
		disabled: askedDisabled,
		onOutcome,
		children,
		actions,
		class: className
	}: {
		spec: FormSpec;
		record: Row | null;
		values: Row;
		modelFields: Fields;
		act: Act;
		fields?: readonly string[];
		sections?: readonly RecordSection[];
		submit?: string;
		readonly?: boolean;
		disabled?: boolean;
		onOutcome?(outcome: Outcome): void;
		children?: Snippet<[FormState]>;
		actions?: Snippet<[FormState]>;
		class?: string;
	} = $props();
	// an update the viewer may read but not make is readonly whatever the page asked. A form is a boundary: a create
	// sheet opened from inside a readonly form is not readonly.
	const scope = useRecordController();
	const shared = scope?.current;
	const matching = untrack(
		() =>
			shared?.spec.target.of === 'collection' &&
			spec.target.of === 'collection' &&
			shared.spec.target.collection === spec.target.collection &&
			shared.spec.target.id === spec.target.id &&
			scope?.historical !== true
	);
	const controls = provideControls(
		() => ({
			readonly: spec.readonly === true || form.mode === 'view' || asked === true,
			disabled: askedDisabled === true
		}),
		true
	);
	const readonly = $derived(controls.readonly);
	const t = uiText();
	const bolt = useBolt();
	// svelte-ignore state_referenced_locally -- a draft is built once per mount; a new row is a new form
	const form =
		matching && shared != null
			? shared
			: new FormState(
					spec,
					record,
					values,
					act,
					{ pendingApproval: t('pendingApproval'), conflict: t('conflict'), unknown: t('unknown') },
					(field) => locked(modelFields, record)(field)
				);
	if (matching) untrack(() => form.prefill(values));
	if (scope?.historical) form.mode = 'view';
	provideForm(form);
	const capabilities = query(() =>
		matching ||
		asked === true ||
		scope?.historical ||
		spec.target.of !== 'collection' ||
		spec.target.mode !== 'update' ||
		spec.target.id === undefined ||
		bolt.recordCapabilities === undefined
			? null
			: bolt.recordCapabilities(spec.target.collection, spec.target.id)
	);
	watch(
		() => [capabilities.current, capabilities.error, capabilities.loading] as const,
		([value, cause]) => {
			if (capabilities.loading) {
				if (record !== null) form.refresh(record);
				form.expectCapabilities();
				return;
			}
			if (cause !== undefined) {
				form.notice = {
					tone: 'danger',
					text: msg(bolt, 'record.permissionsFailed', 'Record permissions could not be loaded.')
				};
				return;
			}
			if (value === undefined) return;
			if (
				value !== null &&
				(value.collection !== spec.target.collection ||
					value.id !== spec.target.id ||
					value.revision !== record?.['revision'])
			) {
				form.notice = { tone: 'warning', text: t('conflict') };
				return;
			}
			form.capabilities = value;
		}
	);
	onDestroy(form.onOutcome((outcome) => onOutcome?.(outcome)));
	// the sheet this form sits in asks before closing over its unsaved draft
	onDestroy(
		getContext<SheetGuard | undefined>(SHEET_GUARD)?.(
			() => !controls.readonly && (form.dirty || form.pending)
		) ?? (() => {})
	);
	const update = $derived(spec.target.of === 'collection' && spec.target.mode === 'update');
	// Matching record forms share the header's Save; independent forms and creates own their submit.
	const ownSubmit = $derived(!matching || !update);
	const visible = $derived(
		(fields ?? spec.fields.map((f) => f.name)).filter(
			(f) => form.readable(f) && spec.fields.some((x) => x.name === f)
		)
	);
	// an update whose every field the row's state locks (a final state, `edit: 'none'`) has nothing to save
	const settled = $derived(
		update &&
			visible.every(
				(f) => spec.fields.find((field) => field.name === f)?.readonly || form.locked(f)
			)
	);

	function send(e: SubmitEvent): void {
		e.preventDefault();
		if (readonly || controls.disabled) return;
		fork(form.submit());
	}
	function beforeUnload(event: BeforeUnloadEvent) {
		if (!readonly && (form.dirty || form.pending)) {
			event.preventDefault();
			event.returnValue = true;
		}
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

<form
	class={['flex h-full min-h-0 min-w-0 flex-col', className]}
	onsubmit={send}
	novalidate
	aria-busy={form.pending}
>
	{#if !matching && asked !== true && !scope?.historical && update && bolt.recordCapabilities !== undefined && form.capabilities === undefined && form.notice === null}
		<div role="status" aria-busy="true"><Spinner /></div>
	{:else}
		<div class="min-h-0 flex-1 overflow-auto pb-4" data-form-body>
			<div class="grid gap-4">
				{#if form.capabilities === null}<Alert variant="secondary">{t('notFound')}</Alert>{/if}
				{#if children}
					{@render children(form)}
				{:else if sections && sections.length > 0}
					{#each groupSections(sections, visible) as g, i (g.section?.name ?? '')}
						{@const s = g.section}
						<Section
							first={i === 0}
							title={s?.title}
							hint={s?.hint}
							name={s?.name}
							defaultOpen={s?.defaultOpen}
							summary={typeof s?.summary === 'function' ? s.summary(form.row) : s?.summary}
						>
							<!-- short fields flow across the width; a structured or long one spans its row (Field) -->
							<Grid minimum="card">{#each g.names as name (name)}<Field {name} />{/each}</Grid>
						</Section>
					{/each}
				{:else}
					<Grid minimum="card">{#each visible as name (name)}<Field {name} />{/each}</Grid>
				{/if}
				{#if form.notice}
					<Alert
						variant={form.notice.tone === 'danger' ? 'destructive' : form.notice.tone}
						role={form.notice.tone === 'danger' ? 'alert' : 'status'}
					>
						{bolt.t(form.notice.text)}
					</Alert>
				{/if}
			</div>
		</div>
		<!-- the action footer : a hairline above, unsaved changes said beside the buttons; none on a readonly form without actions -->
		{#if (!readonly && !settled && ownSubmit) || actions}<footer
				class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t py-3"
				data-form-footer
			>
				{#if !readonly && update && form.dirty && !form.pending}<span
						class="text-meta mr-auto"
						role="status">{t('unsaved')}</span
					>{/if}
				{@render actions?.(form)}
				{#if !readonly && !settled && ownSubmit}<Button
						type="submit"
						disabled={!form.canSave || controls.disabled || (update && !form.dirty)}
					>
						{#if form.pending}<Spinner class="size-4" />{t('saving')}{:else}{form.requestingApproval
								? t('requestApproval')
								: (submit ??
									(spec.target.of === 'collection' && !update ? t('create') : t('save')))}{/if}
					</Button>{/if}
			</footer>{/if}
	{/if}
</form>
