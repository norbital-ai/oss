<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { Button } from '#lib/button';
	import { Inline } from '#lib/layout';

	let {
		currentStepIndex,
		stepCount,
		isFirstStep,
		disabled,
		disabledForwardNavigation,
		onPrevious,
		onNext
	}: {
		currentStepIndex: number;
		stepCount: number;
		isFirstStep: boolean;
		disabled: boolean;
		disabledForwardNavigation: boolean;
		onPrevious: () => void;
		onNext: () => void;
	} = $props();

	const nextDisabled = $derived(disabled ? false : disabledForwardNavigation);
</script>

<div class="flex h-11 items-center justify-between border-b px-4">
	<Inline gap="sm">
		<Button
			variant="ghost"
			size="icon"
			class="shrink-0 text-muted-foreground"
			onclick={onPrevious}
			aria-label="Go to previous step"
			disabled={isFirstStep}
		>
			<Icon icon="lucide:chevron-left" class="h-4 w-4" />
		</Button>
		<Badge variant="outline" class="h-5 px-2 text-micro text-muted-foreground">
			Step {Math.min(currentStepIndex + 1, stepCount)}/{stepCount}
		</Badge>
		<Button
			variant="ghost"
			size="icon"
			class="shrink-0 text-muted-foreground"
			onclick={onNext}
			aria-label="Go to next step"
			disabled={nextDisabled}
		>
			<Icon icon="lucide:chevron-right" class="h-4 w-4" />
		</Button>
	</Inline>
</div>
