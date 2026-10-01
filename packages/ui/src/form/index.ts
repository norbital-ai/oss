// `Form` and `Field` (§3.6): generated from a collection's exposure, drafts kept until the outcome, only changed fields sent.
export { default as Field, type FieldEditor, type FieldProps } from './field.svelte';
export { default as Fieldset, type FieldsetProps } from './fieldset.svelte';
export { default as Section, type RecordSection, type SectionProps } from './section.svelte';
import type { ComponentConstructorOptions, SvelteComponent } from 'svelte';
import FormView, { type FormProps, type FormSource } from './form.svelte';
/** `Form` typed by its `of`: a collection's row and create input, or an action's input. */
export const Form = FormView as unknown as {
	new <const S extends FormSource>(options: ComponentConstructorOptions<FormProps<S>>): SvelteComponent<FormProps<S>>;
	<const S extends FormSource>(internal: unknown, props: FormProps<S>): {};
};
export type { FormProps, FormSource };
export { FormState, useForm } from './form-state.svelte.js';
export type { Outcome, Row } from './draft.js';
