<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	// A record (shared header Save) or a create form (footer Save) whose `FormState` is handed to the test.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	import { type ModelExposure } from '../src/kinds/context.js';
	import { type ViewBolt } from '../src/client/contract.js';
	import RecordShell from '../src/record/RecordShell.svelte';
	import Form from '../src/form/form.svelte';
	import Field from '../src/form/field.svelte';
	import Sheet from '../src/primitives/sheet/sheet.svelte';
	import type { FormState } from '../src/form/form-state.svelte.js';
	const validate = (values: Readonly<Record<string, unknown>>) =>
		values['title'] === 'bad' ? [{ field: 'title', message: 'Title cannot be bad' }] : [];
	let {
		bolt,
		catalog,
		part,
		onForm
	}: {
		bolt: ViewBolt;
		catalog: Record<string, ModelExposure>;
		part: 'record' | 'create' | 'sheet';
		onForm(form: FormState): void;
	} = $props();
	let open = $state(true);
	// svelte-ignore state_referenced_locally
	const ctx: UiContext = { ui: { bolt: bolt, kinds: {
		get catalog() {
			return catalog;
		}
	} } };
</script>

{#if part === 'record'}
	<RecordShell {ctx} of="jobs" id="j1">
		{#snippet children()}
			<Form {ctx} of="jobs" id="j1" {validate}>
				{#snippet children(form)}<div {@attach () => onForm(form)}>
						<Field {ctx} name="title" />
					</div>{/snippet}
			</Form>
		{/snippet}
	</RecordShell>
{:else if part === 'sheet'}
	<button onclick={() => (open = true)}>Reopen</button>
	<Sheet bind:open title="Create job">{@render create()}</Sheet>
{:else}
	{@render create()}
{/if}

{#snippet create()}
	<Form {ctx} of="jobs" mode="create" {validate}>
		{#snippet children(form)}<div {@attach () => onForm(form)}>
				<Field {ctx} name="title" />
			</div>{/snippet}
	</Form>
{/snippet}
