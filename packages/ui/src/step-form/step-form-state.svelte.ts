import type { FormSchema, InferSchema } from '../form/form_state.svelte';
import { fieldAndFormErrorsFromStandardIssues } from '../form/standard_schema_form_errors';
import type { Step, StepFormConfig, StepFormSubmitContract } from './types';

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
			result !== null && typeof result === 'object' ? Reflect.get(result, 'issues') : undefined;

		if (!Array.isArray(issues)) {
			this.submission.clearErrors();
			return true;
		}

		this.submission.setErrors(fieldAndFormErrorsFromStandardIssues(issues));
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
