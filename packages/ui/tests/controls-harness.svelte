<script lang="ts">
	// A form laid out by hand: one field overriding the form's mode, and a bare Input inside a Fieldset.
	import Field from '../src/form/field.svelte';
	import Fieldset from '../src/form/fieldset.svelte';
	import Form from '../src/form/form.svelte';
	import Input from '../src/primitives/input/input.svelte';

	let { record, readonly, disabled, override, group }: {
		record: never; readonly?: boolean; disabled?: boolean; override?: boolean; group: 'readonly' | 'disabled';
	} = $props();
</script>

<Form of="jobs" id="j1" {record} {readonly} {disabled}>
	<Field name="title" />
	<Field name="crew" readonly={override} />
</Form>
<Fieldset readonly={group === 'readonly'} disabled={group === 'disabled'}>
	<div data-bare><Input value="bare" /></div>
</Fieldset>
