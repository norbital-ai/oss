<script lang="ts">
	import { Icon } from '@norbital-ai/ui';

	let { id, class: className = 'size-5' }: { id: string; class?: string } = $props();
</script>

<span
	class="inline-flex shrink-0 items-center justify-center text-muted-foreground {className}"
	aria-hidden="true"
	data-agent-avatar={id}
>
	<Icon name="lucide:bot" class="size-full" />
</span>
