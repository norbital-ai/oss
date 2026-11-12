<script lang="ts">
	// The mounted draft: built once its row is known, and handed to every `Field` below by context.
	import { Effect } from 'effect';
	import { fork, observe_once } from '../effect/index.js';
	import { getContext, onDestroy, untrack } from 'svelte';
	import { watch } from 'runed';
	import Alert from '../primitives/alert/alert.svelte';
	import Button from '../primitives/button/button.svelte';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { provideControls, ui_text } from '../primitives/utils.js';
	import type { Fields } from '../kinds/kind.js';
	import { draftKey, locked, type FormSpec, type Row } from './draft.js';
	import Field from './field.svelte';
	import Grid from '../layout/grid.svelte';
	import RunStatus from '../runs/RunStatus.svelte';
	import Section, { groupSections } from './section.svelte';
	import { useBolt } from '../client/context.js';
	import { msg } from '../text/messages.js';
	import { FormState, provideForm, use_record_controller, type Act } from './form-state.svelte.js';
	import { confirm_action } from '../primitives/dialog/confirm.js';
	import type { FormProps } from './form.svelte';
	import { pendingUnload } from './unload.js';

	let {
		spec,
		record,
		values,
		model_fields,
		act,
		fields,
		sections,
		submit,
		readonly: asked,
		disabled: askedDisabled,
		on_outcome,
		confirm,
		validate,
		children,
		actions,
		class: className
	}: Pick<FormProps, 'sections' | 'submit' | 'readonly' | 'disabled' | 'on_outcome' |
		'confirm' | 'validate' | 'children' | 'actions' | 'class'> & {
		spec: FormSpec;
		record: Row | null;
		values: Row;
		model_fields: Fields;
		act: Act;
		fields?: readonly string[];
	} = $props();
	// an update the viewer may read but not make is readonly whatever the page asked. A form is a boundary: a create
	// sheet opened from inside a readonly form is not readonly.
	const scope = use_record_controller();
	const shared = scope?.current;
	const matching = untrack(
		() =>
			shared?.spec.target.of === 'model' &&
			spec.target.of === 'model' &&
			shared.spec.target.model === spec.target.model &&
			shared.spec.target.id === spec.target.id &&
			scope?.historical !== true
	);
	const submitOwner = getContext<{
		add(entry: {
			readonly label: string | undefined;
			readonly writable: boolean;
			readonly disabled: boolean;
		}): () => void;
	} | undefined>(Symbol.for('ui.record.form.submit'));
	const nativeSubmit = matching ? submitOwner : undefined;
	const controls = provideControls(
		() => ({
			readonly: spec.readonly === true || form.mode === 'view' || asked === true,
			disabled: askedDisabled === true
		}),
		true
	);
	const readonly = $derived(controls.readonly);
	const t = ui_text();
	const bolt = useBolt();
	// svelte-ignore state_referenced_locally -- the key belongs to this mounted form
	const storageKey = scope?.historical === true ? undefined : draftKey(bolt.actor, spec, values);
	// svelte-ignore state_referenced_locally -- a draft is built once per mount; a new row is a new form
	const form =
		matching && shared != null
			? shared
			: new FormState(
					spec,
					record,
					values,
					act,
					{
						pending_approval: t('pending_approval'),
						conflict: t('conflict'),
						unknown: t('unknown'),
						running: t('running')
					},
					(field) => locked(model_fields, record, spec.locks)(field),
					(automation, input) => bolt.run(automation, input),
					storageKey
				);
	if (matching) untrack(() => form.prefill(values));
	if (scope?.historical) form.mode = 'view';
	provideForm(form);
	onDestroy(form.add_validation(() => (readonly ? [] : (validate?.(form.row) ?? []))));
	const capabilities = observe_once(() =>
		matching ||
		asked === true ||
		scope?.historical ||
		spec.target.of !== 'model' ||
		spec.target.mode !== 'update' ||
		spec.target.id === undefined ||
		bolt.record_capabilities === undefined
			? null
			: bolt.record_capabilities(spec.target.model, spec.target.id)
	);
	watch(
		() => [capabilities.current, capabilities.error, capabilities.loading] as const,
		([value, cause]) => {
			if (capabilities.loading) {
				if (record !== null) form.refresh(record);
				form.expect_capabilities();
				return;
			}
			if (cause !== undefined) {
				form.notice = {
					tone: 'danger',
					text: msg(bolt, 'record.permissionsFailed')
				};
				return;
			}
			if (value === undefined) return;
			if (
				value !== null &&
				spec.target.of === 'model' &&
				(value.model !== spec.target.model ||
					value.id !== spec.target.id ||
					value.revision !== record?.['revision'])
			) {
				form.notice = { tone: 'warning', text: t('conflict') };
				return;
			}
			form.capabilities = value;
		}
	);
	onDestroy(form.on_outcome((outcome) => on_outcome?.(outcome)));
	onDestroy(
		form.confirm_submit(() => {
			const asked = confirm?.({ values: form.values, before: form.base });
			return asked == null ? Effect.succeed(true) : confirm_action(asked);
		})
	);
	const update = $derived(spec.target.of === 'model' && spec.target.mode === 'update');
	// A matching record's standard controls belong to its fixed native footer; independent forms own their submit.
	const ownSubmit = $derived(!matching || (!update && nativeSubmit === undefined));
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
	watch(
		() => nativeSubmit,
		(owner) => owner?.add({
			get label() {
				return submit;
			},
			get writable() {
				return !readonly && !settled;
			},
			get disabled() {
				return controls.disabled;
			}
		})
	);

	function send(e: SubmitEvent): void {
		e.preventDefault();
		if (readonly || controls.disabled) return;
		fork(form.submit());
	}
	const beforeUnload = pendingUnload(() => !readonly && form.pending);
</script>

<svelte:window onbeforeunload={beforeUnload} />

<form
	class={['flex h-full min-h-0 min-w-0 flex-col', className]}
	onsubmit={send}
	novalidate
	aria-busy={form.pending}
>
	{#if !matching && asked !== true && !scope?.historical && update && bolt.record_capabilities !== undefined && form.capabilities === undefined && form.notice === null}
		<div role="status" aria-busy="true"><Spinner /></div>
	{:else}
		<!-- the gutter is kept: a section opening past the fold never narrows the body under a classic scrollbar -->
		<div class="min-h-0 flex-1 overflow-auto pb-4 [scrollbar-gutter:stable]" data-form-body>
			<!-- a column the body's height bounds: open sections share it and scroll inside themselves -->
			<div class="flex h-full flex-col gap-4">
				{#if form.capabilities === null}<Alert variant="secondary">{t('not_found')}</Alert>{/if}
				{#if children}
					{@render children(form)}
				{:else if sections && sections.length > 0}
					{#each groupSections(sections, visible) as g, i (g.section?.name ?? '')}
						{@const s = g.section}
						<Section
							first={i === 0}
							title={s?.title}
							icon={s?.icon}
							hint={s?.hint}
							name={s?.name}
							default_open={s?.default_open}
							summary={typeof s?.summary === 'function' ? s.summary(form.row) : s?.summary}
						>
							<!-- short fields flow across the width; a structured or long one spans its row (Field) -->
							<Grid minimum="card"
								>{#each g.names as name (name)}<Field {name} />{/each}</Grid
							>
						</Section>
					{/each}
				{:else}
					<Grid minimum="card"
						>{#each visible as name (name)}<Field {name} />{/each}</Grid
					>
				{/if}
				{#if form.notice}
					<Alert
						variant={form.notice.tone === 'danger' ? 'destructive' : form.notice.tone}
						role={form.notice.tone === 'danger' ? 'alert' : 'status'}
					>
						{bolt.t(form.notice.text)}
					</Alert>
				{/if}
				{#if form.run !== null}<RunStatus
						automation={form.run.automation}
						run={form.run}
					/>{:else if form.notice?.run !== undefined}<RunStatus
						automation={spec.callable}
						run={form.notice.run}
					/>{/if}
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
				{#if !readonly && !update && ownSubmit}<Button
						variant="outline"
						disabled={form.pending || controls.disabled}
						onclick={() => form.reset()}>{t('clear')}</Button
					>{/if}
				{#if !readonly && !settled && ownSubmit}<Button
						type="submit"
						disabled={!form.can_save || controls.disabled || (update && !form.dirty)}
					>
						{#if form.pending}<Spinner class="size-4" />{spec.target.of === 'automation'
								? msg(bolt, 'run.starting')
								: t('saving')}{:else}{form.resubmitting
								? msg(bolt, 'record.resubmit')
								: form.requesting_approval
									? t('requestApproval')
									: (submit ??
										(spec.target.of === 'automation'
											? msg(bolt, 'run.start')
											: !update
												? t('create')
												: t('save')))}{/if}
					</Button>{/if}
			</footer>{/if}
	{/if}
</form>
