<script lang="ts">
	import { Button } from '#lib/button';
	import { cn } from '#lib/utils';
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
		class: className,
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
		void Effect.runPromise(
			Effect.gen(function* () {
				yield* Effect.promise(() => tick());
				ref?.focus();
			})
		);
	};
</script>

<div
	class={cn('relative', containerClass)}
	role="group"
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
>
	<Input bind:ref bind:value class={className} disabled={isInputDisabled} {...restProps} />
	{#if !disabled && hovered}
		<Button
			variant="ghost"
			size="sm"
			class="absolute top-1/2 right-1 h-6 -translate-y-1/2 px-2 text-tiny"
			onclick={toggleEditing}
			type="button"
		>
			{isEditing ? 'Done' : 'Edit'}
		</Button>
	{/if}
</div>
