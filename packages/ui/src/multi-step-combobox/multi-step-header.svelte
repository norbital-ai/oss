<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Badge } from '#lib/badge';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline } from '#lib/layout';

	const { t } = useI18n<UiKeys>();

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
			aria-label={t('common.previousStep')}
			disabled={isFirstStep}
		>
			<Icon icon="lucide:chevron-left" class="h-4 w-4" />
		</Button>
		<Badge variant="outline" class="h-5 px-2 text-micro text-muted-foreground">
			{t('common.stepOf', {
				current: Math.min(currentStepIndex + 1, stepCount),
				total: stepCount
			})}
		</Badge>
		<Button
			variant="ghost"
			size="icon"
			class="shrink-0 text-muted-foreground"
			onclick={onNext}
			aria-label={t('common.nextStep')}
			disabled={nextDisabled}
		>
			<Icon icon="lucide:chevron-right" class="h-4 w-4" />
		</Button>
	</Inline>
</div>
