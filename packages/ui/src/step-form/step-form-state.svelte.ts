import type { FormSchema, InferSchema } from '../form/form_state.svelte';
import { Schema } from 'effect';
import { fieldAndFormErrorsFromStandardIssues } from '#lib/form/standard_schema_form_errors';
import type { Step, StepFormConfig, StepFormSubmitContract } from '#lib/step-form/types';

/** Bare `typeof x === 'object'` acceptance of the Standard Schema answer: arrays included, null excluded. */
const isObjectish = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);

export class StepFormState<T extends FormSchema> {
	currentStep = $state(0);
	readonly steps: Step<T>[];
	readonly submission: StepFormSubmitContract<InferSchema<T>>;
	private readonly onStepValidationFailed?: () => void;

	progress = $derived.by(() => {
		const n = this.steps.length;
		if (n <= 1) return 100;
		return (this.currentStep / (n - 1)) * 100;
	});

	constructor(config: StepFormConfig<T>) {
		this.steps = config.steps;
		this.submission = config.submission;
		this.onStepValidationFailed = config.onStepValidationFailed;
	}

	validateCurrentStep(): boolean {
		const currentSchema = this.steps[this.currentStep].schema;
		const data = this.submission.getData();
		const result = currentSchema['~standard'].validate(data);
		const issues =
			result !== null && isObjectish(result) ? Reflect.get(result, 'issues') : undefined;

		if (!Array.isArray(issues)) {
			this.submission.clearErrors();
			return true;
		}

		const errors = fieldAndFormErrorsFromStandardIssues(issues);
		this.submission.setErrors({
			fieldErrors: { ...errors.fieldErrors },
			formErrors: [...errors.formErrors]
		});
		this.onStepValidationFailed?.();
		return false;
	}

	next(): void {
		if (!this.validateCurrentStep()) return;
		if (this.currentStep === this.steps.length - 1) return;
		this.currentStep += 1;
	}

	previous(): void {
		if (this.currentStep > 0) this.currentStep -= 1;
	}
}
