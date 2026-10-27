<script lang="ts">
	// A record (shared header Save) or a create form (footer Save) whose `FormState` is handed to the test.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	import { provideKinds, type ModelExposure } from '../src/kinds/context.js';
	import { provideBolt } from '../src/client/context.js';
	import { type ViewBolt } from '../src/client/contract.js';
	import RecordShell from '../src/record/RecordShell.svelte';
	import Form from '../src/form/form.svelte';
	import Field from '../src/form/field.svelte';
	import type { FormState } from '../src/form/form-state.svelte.js';
	let {
		bolt,
		catalog,
		part,
		onForm
	}: {
		bolt: ViewBolt;
		catalog: Record<string, ModelExposure>;
		part: 'record' | 'create';
		onForm(form: FormState): void;
	} = $props();
	// svelte-ignore state_referenced_locally
	provideBolt(bolt);
	provideKinds({
		get catalog() {
			return catalog;
		}
	});
</script>

{#if part === 'record'}
	<RecordShell of="jobs" id="j1">
		{#snippet children()}
			<Form of="jobs" id="j1">
				{#snippet children(form)}<div {@attach () => onForm(form)}>
						<Field name="title" />
					</div>{/snippet}
			</Form>
		{/snippet}
	</RecordShell>
{:else}
	<Form of="jobs" mode="create">
		{#snippet children(form)}<div {@attach () => onForm(form)}>
				<Field name="title" />
			</div>{/snippet}
	</Form>
{/if}
