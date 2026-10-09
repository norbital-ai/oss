<script lang="ts">
	// The mounted draft: built once its row is known, and handed to every `Field` below by context.
	import { getContext, onDestroy, type Snippet } from 'svelte';
	import { SHEET_GUARD, type SheetGuard } from '../primitives/sheet/dismiss.js';
	import Alert from '../primitives/alert/alert.svelte';
	import Button from '../primitives/button/button.svelte';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { provideControls, uiText } from '../primitives/utils.js';
	import type { Fields } from '../kinds/kind.js';
	import { locked, type FormSpec, type Outcome, type Row } from './draft.js';
	import Field from './field.svelte';
	import Section, { groupSections, type RecordSection } from './section.svelte';
	import RecordInfo from './record-info.svelte';
	import { FormState, provideForm, type Act } from './form-state.svelte.js';

	let { spec, record, values, modelFields, act, fields, sections, submit, readonly: asked, disabled: askedDisabled, onOutcome, children, actions, class: className }: {
		spec: FormSpec; record: Row | null; values: Row; modelFields: Fields; act: Act; fields?: readonly string[]; sections?: readonly RecordSection[]; submit?: string; readonly?: boolean;
		disabled?: boolean; onOutcome?(outcome: Outcome): void; children?: Snippet<[FormState]>; actions?: Snippet<[FormState]>; class?: string;
	} = $props();
	// an update the viewer may read but not make is readonly whatever the page asked. A form is a boundary: a create
	// sheet opened from inside a readonly form is not readonly.
	const controls = provideControls(() => ({ readonly: spec.readonly === true || asked === true, disabled: askedDisabled === true }));
	const readonly = $derived(controls.readonly);
	const t = uiText();
	// svelte-ignore state_referenced_locally -- a draft is built once per mount; a new row is a new form
	const form = new FormState(spec, record, values, act, { pendingApproval: t('pendingApproval'), conflict: t('conflict'), unknown: t('unknown') }, locked(modelFields, record));
	provideForm(form);
	// the sheet this form sits in asks before closing over its unsaved draft
	onDestroy(getContext<SheetGuard | undefined>(SHEET_GUARD)?.(() => !controls.readonly && form.dirty && !form.pending) ?? (() => {}));
	const update = $derived(spec.target.of === 'collection' && spec.target.mode === 'update');
	const visible = $derived((fields ?? spec.fields.map((f) => f.name)).filter((f) => spec.fields.some((x) => x.name === f)));
	// an update whose every field the row's state locks (a final state, `edit: 'none'`) has nothing to save
	const settled = $derived(update && visible.every((f) => form.locked(f)));

	async function send(e: SubmitEvent) {
		e.preventDefault();
		if (readonly || controls.disabled) return;
		const outcome = await form.submit();
		if (outcome !== null) onOutcome?.(outcome);
	}
	function beforeUnload(event: BeforeUnloadEvent) {
		if (!readonly && (form.dirty || form.pending)) {
			event.preventDefault();
			event.returnValue = true;
		}
	}
</script>

<svelte:window onbeforeunload={beforeUnload} />

<form class={['flex h-full min-h-0 min-w-0 flex-col', className]} onsubmit={send} novalidate aria-busy={form.pending}>
	<div class="min-h-0 flex-1 overflow-auto pb-4" data-form-body>
	<div class="grid gap-4">
	{#if children}
		{@render children(form)}
	{:else if sections && sections.length > 0}
		{#each groupSections(sections, visible) as g, i (g.section?.name ?? '')}
			{@const s = g.section}
			<Section first={i === 0} title={s?.title} hint={s?.hint} name={s?.name} defaultOpen={s?.defaultOpen} summary={typeof s?.summary === 'function' ? s.summary(form.row) : s?.summary}>
				{#each g.names as name (name)}<Field {name} />{/each}
			</Section>
		{/each}
	{:else}
		{#each visible as name (name)}<Field {name} />{/each}
	{/if}
	{#if form.notice}
		<Alert variant={form.notice.tone === 'danger' ? 'destructive' : form.notice.tone} role={form.notice.tone === 'danger' ? 'alert' : 'status'}>
			{form.notice.text}
		</Alert>
	{/if}
	{#if update && record !== null}<RecordInfo row={record} />{/if}
	</div>
	</div>
	<!-- the action footer (staging's): a hairline above, unsaved changes said beside the buttons; none on a readonly form without actions -->
	{#if (!readonly && !settled) || actions}<footer class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t py-3" data-form-footer>
		{#if !readonly && update && form.dirty && !form.pending}<span class="text-meta mr-auto" role="status">{t('unsaved')}</span>{/if}
		{@render actions?.(form)}
		{#if !readonly && !settled}<Button type="submit" disabled={form.pending || controls.disabled || (update && !form.dirty)}>
			{#if form.pending}<Spinner class="size-4" />{t('saving')}{:else}{submit ?? (spec.target.of === 'collection' && !update ? t('create') : t('save'))}{/if}
		</Button>{/if}
	</footer>{/if}
</form>
