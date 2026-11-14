// `Form` and `Field`: generated from a model's exposure, drafts kept until the outcome, only changed fields sent.
export { default as Field, type FieldEditor, type FieldProps, type FieldView } from './field.svelte';
export { default as DescriptionHint } from './description-hint.svelte';
export { default as Section, type RecordSection, type SectionProps } from './section.svelte';
/** Edits a model row or an automation's typed input using permitted fields; drafts survive pending work and updates submit only changed values. */
export { default as Form, type FormConfirm, type FormProps, type FormSource } from './form.svelte';
export {
	FormState,
	use_form,
	use_record_controller,
	type RecordControllerScope,
	type SemanticIssue
} from './form-state.svelte.js';
export type { Outcome } from '../client/contract.js';
export type { Row } from './draft.js';
