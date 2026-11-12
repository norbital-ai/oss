<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import Field from '../form/field.svelte';
	import { provideForm, type FormState } from '../form/form-state.svelte.js';
	import Spinner from '../primitives/spinner/spinner.svelte';
	import { provide_model } from '../model/context.js';
	import { bolt_of } from '../client/context.js';
	import { msg } from '../text/messages.js';
	let {
		ctx,
		form,
		name,
		readonly = false,
		disabled = false,
		pending_permissions = false
	}: {
		ctx: UiContext;
		form: FormState;
		name: string;
		readonly?: boolean;
		disabled?: boolean;
		pending_permissions?: boolean;
	} = $props();
	// svelte-ignore state_referenced_locally -- each mounted cell belongs to one native row controller.
	provideForm(form);
	provide_model(() =>
		form.spec.target.of === 'model' ? form.spec.target.model : ''
	);
	const bolt = $derived(bolt_of(ctx));
</script>

{#if pending_permissions}<span
		role="status"
		aria-label={msg(bolt, 'child.loadingPermissions')}
		><Spinner class="size-4" /></span
	>
{:else}<Field {ctx} {name} {readonly} {disabled} dense />{/if}
