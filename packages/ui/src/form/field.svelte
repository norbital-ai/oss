<script lang="ts" generics="TInput extends FormSchema, TReturn, TPath extends string">
	import type { FieldOrientation } from '#lib/field';
	import * as FieldPrimitive from '#lib/field';
	import type { Snippet } from 'svelte';
	import { setField, type FieldProps } from '#lib/form/context';
	import type { FormState, FormSchema, InferSchema } from './form_state.svelte';
	import type { Get } from '#lib/form/path';

	let {
		name,
		form,
		class: className,
		orientation = 'vertical',
		children
	}: {
		name: TPath;
		form: FormState<TInput, TReturn>;
		class?: string;
		orientation?: FieldOrientation;
		children?: Snippet<[{ field: FieldProps<Get<InferSchema<TInput>, TPath>> }]>;
	} = $props();

	const field = {
		get name() {
			return name;
		},
		get value() {
			return form.getValue(name);
		},
		get errors() {
			return form.getFieldErrors(name);
		},
		get delta() {
			return form.getDeltaForPath(name);
		},
		get disabled() {
			return form.disabled;
		},
		handleChange: (next: Get<InferSchema<TInput>, TPath>) => {
			form.setValueAtPath(name, next);
		},
		handleBlur: () => {
			form.clearFieldError(name);
		}
	};

	setField<Get<InferSchema<TInput>, TPath>>(() => field);

	const hasErrors = $derived(field.errors.length > 0);
</script>

<FieldPrimitive.Field {orientation} data-invalid={hasErrors} class={className}>
	{@render children?.({ field })}
</FieldPrimitive.Field>
