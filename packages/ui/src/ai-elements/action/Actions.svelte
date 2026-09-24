<script lang="ts">
	import { Inline } from '#lib/layout';
	import type { HTMLAttributes } from 'svelte/elements';

	type ActionsProps = HTMLAttributes<HTMLDivElement>;

	let { children, ...restProps }: ActionsProps = $props();
</script>

<Inline gap="xs" {...restProps}>
	{@render children?.()}
</Inline>
