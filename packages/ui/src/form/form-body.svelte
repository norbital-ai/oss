<script lang="ts">
	// The mounted draft: built once its row is known, and handed to every `Field` below by context.
	import type { Snippet } from 'svelte';
	import Alert from '../primitives/alert/alert.svelte';
	import Button from '../primitives/button/button.svelte';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { provideControls, uiText } from '../primitives/utils.js';
	import type { Fields } from '../kinds/kind.js';
	import { locked, type FormSpec, type Outcome, type Row } from './draft.js';
	import Field from './field.svelte';
	import RecordInfo from './record-info.svelte';
	import { FormState, provideForm, type Act } from './form-state.svelte.js';

	let { spec, record, values, modelFields, act, fields, submit, readonly: asked, disabled: askedDisabled, onOutcome, children, actions, class: className }: {
		spec: FormSpec; record: Row | null; values: Row; modelFields: Fields; act: Act; fields?: readonly string[]; submit?: string; readonly?: boolean;
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
	const update = $derived(spec.target.of === 'collection' && spec.target.mode === 'update');
	const visible = $derived((fields ?? spec.fields.map((f) => f.name)).filter((f) => spec.fields.some((x) => x.name === f)));

	async function send(e: SubmitEvent) {
		e.preventDefault();
		if (readonly || controls.disabled) return;
		const outcome = await form.submit();
		if (outcome !== null) onOutcome?.(outcome);
	}
</script>

<form class={className ?? 'grid gap-4'} onsubmit={send} novalidate aria-busy={form.pending}>
	{#if children}
		{@render children(form)}
	{:else}
		{#each visible as name (name)}<Field {name} />{/each}
	{/if}
	{#if form.notice}
		<Alert variant={form.notice.tone === 'danger' ? 'destructive' : form.notice.tone} role={form.notice.tone === 'danger' ? 'alert' : 'status'}>
			{form.notice.text}
		</Alert>
	{/if}
	{#if update && record !== null}<RecordInfo row={record} />{/if}
	<!-- the action footer (staging's): a hairline above, unsaved changes said beside the buttons; none on a readonly form without actions -->
	{#if !readonly || actions}<footer class="flex flex-wrap items-center justify-end gap-2 border-t pt-3" data-form-footer>
		{#if !readonly && update && form.dirty && !form.pending}<span class="text-meta mr-auto" role="status">{t('unsaved')}</span>{/if}
		{@render actions?.(form)}
		{#if !readonly}<Button type="submit" disabled={form.pending || controls.disabled || (update && !form.dirty)}>
			{#if form.pending}<Spinner class="size-4" />{t('saving')}{:else}{submit ?? (spec.target.of === 'collection' && !update ? t('create') : t('save'))}{/if}
		</Button>{/if}
	</footer>{/if}
</form>
