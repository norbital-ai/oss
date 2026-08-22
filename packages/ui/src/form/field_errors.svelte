<script lang="ts">
	import * as FieldPrimitive from '#lib/field';
	import { getField } from '#lib/form/context';

	let { class: className }: { class?: string } = $props();

	const field = getField()();

	// Map string[] errors to { message: string }[] format expected by FieldPrimitive.Error
	const mappedErrors = $derived(field?.errors?.map((error) => ({ message: error })) ?? []);
</script>

<FieldPrimitive.Error errors={mappedErrors} class={className} />
