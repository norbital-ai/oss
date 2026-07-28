<script lang="ts" generics="T extends FormSchema">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#lib/card';
	import { ProgressPicker } from '#lib/progress';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import type { FormSchema } from '../form/form_state.svelte';
	import type { StepFormState } from './step-form-state.svelte';

	let {
		stepFormState,
		class: className,
		StepsForm,
		disableSubmit
	} = $props<{
		stepFormState: StepFormState<T>;
		StepsForm: Snippet<[]>;
		class?: string;
		disableSubmit?: boolean;
	}>();
	let hasErrors = $derived.by(() => {
		const errs = stepFormState.submission.errors;
		return Object.keys(errs.fieldErrors ?? {}).length > 0 || (errs.formErrors ?? []).length > 0;
	});
	let currentStepTitle: string | Snippet = $derived.by(() => {
		return stepFormState.steps[stepFormState.currentStep].title;
	});
</script>

<form class={cn('w-full', className)} onsubmit={stepFormState.submission.handleSubmit}>
	<Card class="w-full border-0 p-0 shadow-none">
		<CardHeader>
			<CardTitle class="flex w-full flex-row justify-between">
				{#if typeof currentStepTitle === 'string'}
					<span class="text-heading">{currentStepTitle}</span>
				{:else if typeof currentStepTitle === 'function'}
					{@render currentStepTitle()}
				{/if}
				<span> </span>
				<div class="text-sm text-muted-foreground">
					Step {stepFormState.currentStep + 1} of {stepFormState.steps.length}
				</div>
			</CardTitle>
			<CardDescription class="flex flex-col">
				<span>
					{stepFormState.steps[stepFormState.currentStep].description}
				</span>
				<ProgressPicker value={stepFormState.progress} />
			</CardDescription>
		</CardHeader>
		<CardContent>
			{@render StepsForm()}
		</CardContent>
		<CardFooter class="flex justify-between">
			<Button
				variant="outline"
				onclick={() => {
					stepFormState.previous();
				}}
				disabled={stepFormState.currentStep === 0}
			>
				<Icon icon="lucide:chevron-left" class="mr-2 h-4 w-4" />
				Previous
			</Button>
			{#if stepFormState.currentStep === stepFormState.steps.length - 1}
				<Button
					type="submit"
					disabled={disableSubmit || hasErrors || stepFormState.submission.isSubmitting}
				>
					<span>Submit</span>
					<Icon icon="lucide:circle-arrow-right" class="ml-2 h-4 w-4" />
				</Button>
			{:else}
				<Button
					type="button"
					onclick={() => {
						stepFormState.next();
					}}
				>
					Next
					<Icon icon="lucide:chevron-right" class="ml-2 h-4 w-4" />
				</Button>
			{/if}
		</CardFooter>
	</Card>
</form>
