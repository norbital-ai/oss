<script lang="ts" generics="T extends FormSchema">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#lib/card';
	import { Inline, Stack } from '#lib/layout';
	import { ProgressPicker } from '#lib/progress';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import type { FormSchema } from '../form/form_state.svelte';
	import type { StepFormState } from './step-form-state.svelte';
	import { Effect } from 'effect';

	const { t } = useI18n<UiKeys>();

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

	function handleSubmit(event: SubmitEvent): void {
		const submission = stepFormState.submission.handleSubmit(event);
		if (submission) Effect.runFork(submission);
	}
</script>

<form class={cn('w-full', className)} onsubmit={handleSubmit}>
	<Card class="w-full border-0 p-0 shadow-none">
		<CardHeader>
			<CardTitle class="w-full">
				<Inline gap="none" justify="between">
					{#if typeof currentStepTitle === 'string'}
						<span class="text-heading">{currentStepTitle}</span>
					{:else if typeof currentStepTitle === 'function'}
						{@render currentStepTitle()}
					{/if}
					<span> </span>
					<div class="text-sm text-muted-foreground">
						{t('misc.stepOf', {
							current: stepFormState.currentStep + 1,
							total: stepFormState.steps.length
						})}
					</div>
				</Inline>
			</CardTitle>
			<CardDescription>
				<Stack as="span" gap="none">
					<span>
						{stepFormState.steps[stepFormState.currentStep].description}
					</span>
					<ProgressPicker value={stepFormState.progress} />
				</Stack>
			</CardDescription>
		</CardHeader>
		<CardContent>
			{@render StepsForm()}
		</CardContent>
		<CardFooter>
			<Inline gap="none" justify="between" grow>
				<Button
					variant="outline"
					onclick={() => {
						stepFormState.previous();
					}}
					disabled={stepFormState.currentStep === 0}
				>
					<Inline as="span" gap="sm">
						<Icon icon="lucide:chevron-left" class="h-4 w-4" />
						{t('common.previous')}
					</Inline>
				</Button>
				{#if stepFormState.currentStep === stepFormState.steps.length - 1}
					<Button
						type="submit"
						disabled={disableSubmit || hasErrors || stepFormState.submission.isSubmitting}
					>
						<Inline as="span" gap="sm">
							<span>{t('common.submit')}</span>
							<Icon icon="lucide:circle-arrow-right" class="h-4 w-4" />
						</Inline>
					</Button>
				{:else}
					<Button
						type="button"
						onclick={() => {
							stepFormState.next();
						}}
					>
						<Inline as="span" gap="sm">
							{t('common.next')}
							<Icon icon="lucide:chevron-right" class="h-4 w-4" />
						</Inline>
					</Button>
				{/if}
			</Inline>
		</CardFooter>
	</Card>
</form>
