<script lang="ts">
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';

	type Props = {
		class?: string;
		plus: number;
	};

	let { plus, class: className }: Props = $props();
</script>

<Inline
	justify="center"
	class={cn('relative size-10 rounded-full bg-accent text-sm ring-2 ring-background', className)}
>
	<span>+{plus}</span>
</Inline>
