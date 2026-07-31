<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { Inline } from '#lib/layout';
	import type { Snippet } from 'svelte';

	type InformationProps = {
		children?: Snippet;
		class?: string;
		text?: string;
	};

	let { class: className, children, text = '', ...restProps }: InformationProps = $props();
</script>

<Inline gap="xs" class="text-sm text-muted-foreground">
	<Icon icon="mingcute:information-line" class={className} {...restProps} />
	<p class={className} {...restProps}>{text}</p>
</Inline>
