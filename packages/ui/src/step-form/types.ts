import type { Snippet } from 'svelte';
import type { FormSchema, InferSchema } from '../form/form_state.svelte';

export type Step<TFinal extends FormSchema> = {
	title: string | Snippet;
	description: string;
	schema: FormSchema;
};

export type StepFormSubmitErrors = {
	fieldErrors: Record<string, string[]>;
	formErrors: string[];
};

export type StepFormSubmitContract<TData> = {
	handleSubmit: (event: Event) => void | Promise<void>;
	readonly isSubmitting: boolean;
	readonly errors: StepFormSubmitErrors;
	getData: () => TData;
	clearErrors: () => void;
	setErrors: (errors: StepFormSubmitErrors) => void;
};

export type StepFormConfig<T extends FormSchema> = {
	steps: Step<T>[];
	submission: StepFormSubmitContract<InferSchema<T>>;
	onStepValidationFailed?: () => void;
};
