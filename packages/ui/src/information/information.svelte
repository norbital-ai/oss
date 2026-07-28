<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import type { Snippet } from 'svelte';

	type InformationProps = {
		children?: Snippet;
		class?: string;
		text?: string;
	};

	let { class: className, children, text = '', ...restProps }: InformationProps = $props();
</script>

<div
	class="grid grid-cols-[repeat(auto-fit,minmax(0px,max-content))] place-items-center gap-1 text-sm text-muted-foreground"
>
	<Icon icon="mingcute:information-line" class={className} {...restProps} />
	<p class={className} {...restProps}>{text}</p>
</div>
