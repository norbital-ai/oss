<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Inline } from '#lib/layout';
	import type { Snippet } from 'svelte';

	type InformationProps = {
		children?: Snippet;
		class?: string;
		text?: string;
	};

	let { children, text = '', ...restProps }: InformationProps = $props();
</script>

<Inline gap="xs" class="text-sm text-muted-foreground">
	<Icon icon="mingcute:information-line" {...restProps} />
	<p {...restProps}>{text}</p>
</Inline>
