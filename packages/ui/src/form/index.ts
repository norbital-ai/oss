// `Form` and `Field` (§3.6): generated from a collection's exposure, drafts kept until the outcome, only changed fields sent.
export { default as Field, type FieldEditor, type FieldProps } from './field.svelte';
export { default as Fieldset, type FieldsetProps } from './fieldset.svelte';
export { default as Section, type RecordSection, type SectionProps } from './section.svelte';
/** Edits a collection row or an action's typed input using permitted fields; drafts survive pending work and updates submit only changed values. */
export { default as Form, type FormProps, type FormSource } from './form.svelte';
export {
	FormState,
	idsOf,
	useForm,
	useRecordController,
	type RecordControllerScope
} from './form-state.svelte.js';
export type { Outcome, Row } from './draft.js';
