<script lang="ts">
	import { cn } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	export type ActionsProps = HTMLAttributes<HTMLDivElement>;

	let { class: className, children, ...restProps }: ActionsProps = $props();
</script>

<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
<div class={cn('flex items-center gap-0.5', className)} {...restProps}>
	{@render children?.()}
</div>
