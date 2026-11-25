<!--
@component
A record view that is one form: the record frame around the model's form, laid out by the `Section`s and `Field`s the
representation composes. A `+representation.svelte` passes its `view` whole; a create opens its new record as
`RecordShell` does.
@example
<RecordForm {ctx} {view} subtitle={['customer', 'due_on']}>
	<Section first name="general"><Field {ctx} name="customer" /></Section>
</RecordForm>
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Outcome, UiContext } from '../client/contract.js';
	import Form, { type FormProps } from '../form/form.svelte';
	import type { FormState } from '../form/form-state.svelte.js';
	import type { ModelKey } from '../model/types.js';
	import type { RunsForProps } from '../runs/RunsFor.svelte';
	import RecordShell, { type RecordHistoryConfig, type RecordTab } from './RecordShell.svelte';
	import type { RecordView } from './types.js';

	let {
		ctx,
		view,
		subtitle,
		actions,
		trailing,
		tabs,
		runs,
		history,
		lock,
		form_actions,
		on_outcome,
		on_done,
		children: body
	}: {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** What the representation received. */
		view: RecordView<ModelKey>;
		/** The fields under the heading, each shown by its kind. */
		subtitle?: readonly string[];
		/** Placed in the record header. */
		actions?: Snippet;
		/** Beside the label in the chrome. */
		trailing?: Snippet;
		/** Authored tabs after the record's own. */
		tabs?: readonly RecordTab[];
		/** Runs whose subject is this record, shown as a Runs tab. */
		runs?: readonly RunsForProps[];
		/** Related records included in the History popover. */
		history?: RecordHistoryConfig;
		/** A UI-only lock reason: the record reads, and the footer shows the lock instead of Edit. */
		lock?: string;
		/** Extra buttons beside the form's submit. */
		form_actions?: Snippet<[FormState]>;
		/** The form's outcome, beside what the frame does with it. */
		on_outcome?: FormProps['on_outcome'];
		/** A committed or held save, in place of the default (a create opens the new record). */
		on_done?: (outcome: Outcome) => void;
		/** The form's layout of `Section`s and `Field`s. */
		children: Snippet<[FormState]>;
	} = $props();
	const of = $derived(view.model);
	const record = $derived(view.mode !== 'create' ? view.record : null);
	const values = $derived(view.mode === 'create' ? view.values : {});
	const locked = $derived(lock !== undefined && record !== null);
</script>

<RecordShell
	{ctx}
	{of}
	mode={view.mode}
	{...record === null ? { values } : { id: record.id }}
	{...subtitle === undefined ? {} : { subtitle }}
	{...actions === undefined ? {} : { actions }}
	{...trailing === undefined ? {} : { trailing }}
	{...tabs === undefined ? {} : { tabs }}
	{...runs === undefined ? {} : { runs }}
	{...history === undefined ? {} : { history }}
	{...locked && lock !== undefined ? { lock } : {}}
	{...on_done === undefined ? {} : { on_done }}
>
	<Form
		{ctx}
		{of}
		mode={locked ? 'view' : view.mode}
		readonly={locked}
		size="content"
		{...record === null ? { values } : { id: record.id, record }}
		{...form_actions === undefined ? {} : { actions: form_actions }}
		{...on_outcome === undefined ? {} : { on_outcome }}
	>
		{#snippet children(form)}
			{@render body(form)}
		{/snippet}
	</Form>
</RecordShell>
