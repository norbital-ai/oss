<script lang="ts" module>
	import { cn } from '#lib/utils';
	import type { ButtonProps } from '#lib/button';

	interface ConversationScrollButtonProps extends ButtonProps {}
</script>

<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Imposter } from '#lib/layout';
	import { getStickToBottomContext } from './stick-to-bottom-context.svelte.js';
	import { fly } from 'svelte/transition';
	import { backOut } from 'svelte/easing';

	let { class: className, onclick, ...restProps }: ConversationScrollButtonProps = $props();

	const context = getStickToBottomContext();

	const handleScrollToBottom = (event: MouseEvent) => {
		context.scrollToBottom();
		if (onclick) {
			onclick(
				event as MouseEvent & {
					currentTarget: EventTarget & HTMLButtonElement;
				}
			);
		}
	};
</script>

{#if !context.isAtBottom}
	<Imposter placement="bottom" class="pointer-events-none pb-4">
		<div
			in:fly|global={{
				duration: 300,
				y: 10,
				easing: backOut
			}}
			out:fly|global={{
				duration: 200,
				y: 10,
				easing: backOut
			}}
			class="pointer-events-auto mx-auto w-fit"
		>
			<Button
				class={cn(
					'bg-background/80 border-border/50 hover:bg-background/90 rounded-full shadow-lg backdrop-blur-sm hover:shadow-xl',
					className
				)}
				onclick={handleScrollToBottom}
				size="icon"
				type="button"
				variant="outline"
				{...restProps}
			>
				<Icon icon="lucide:arrow-down" class="size-4" />
			</Button>
		</div>
	</Imposter>
{/if}
