<script lang="ts">
	import { Button } from '#lib/button';
	import { Imposter } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { toError } from '@norbital-ai/std';
	import { Effect } from 'effect';
	import { tick, type ComponentProps } from 'svelte';
	import Input from './input.svelte';

	type Props = ComponentProps<typeof Input> & {
		/**
		 * Additional CSS classes to apply to the container wrapper.
		 */
		containerClass?: string;
	};

	let {
		ref = $bindable(null),
		value = $bindable(),
		containerClass,
		disabled = false,
		...restProps
	}: Props = $props();

	/**
	 * Internal state to track if the input container is being hovered.
	 * This is used to show the Edit/Done button.
	 */
	let hovered = $state(false);

	/**
	 * Internal state to track if the input is in editing mode.
	 */
	let isEditing = $state(false);

	/**
	 * Determines if the input should be disabled based on isEditing state.
	 */
	const isInputDisabled = $derived(disabled || !isEditing);

	/**
	 * Toggles the editing state when the Edit/Done button is clicked.
	 */
	const toggleEditing = () => {
		isEditing = !isEditing;
		if (!isEditing) return;
		Effect.runFork(
			Effect.tryPromise({ try: () => tick(), catch: toError }).pipe(
				Effect.map(() => ref?.focus()),
				Effect.ignoreCause({
					log: true,
					message: '[ControlledEditInput] Failed to focus the editable input'
				})
			)
		);
	};
</script>

<div
	class={cn('relative', containerClass)}
	role="group"
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
>
	<Input bind:ref bind:value disabled={isInputDisabled} {...restProps} />
	{#if !disabled && hovered}
		<Imposter placement="center-end" offset="xs" class="leading-none">
			<Button
				variant="ghost"
				size="sm"
				class="h-6 px-2 align-top text-tiny"
				onclick={toggleEditing}
				type="button"
			>
				{isEditing ? 'Done' : 'Edit'}
			</Button>
		</Imposter>
	{/if}
</div>
