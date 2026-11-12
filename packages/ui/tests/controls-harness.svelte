<script lang="ts">
	// A form laid out by hand: one field overriding the form's mode.
	import Field from '../src/form/field.svelte';
	import Form from '../src/form/form.svelte';
	import type { Row } from '../src/model/types.js';
	import type { UiContext } from '../src/client/contract.js';

	let {
		ctx,
		record,
		readonly,
		disabled,
		override
	}: {
		ctx: UiContext;
		record: Row | null | undefined;
		readonly?: boolean;
		disabled?: boolean;
		override?: boolean;
	} = $props();
</script>

<Form {ctx} of="jobs" id="j1" {record} {readonly} {disabled}>
	<Field {ctx} name="title" />
	<Field {ctx} name="crew" readonly={override} />
</Form>
