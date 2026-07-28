<script lang="ts">
	import { Checkbox } from '#lib/checkbox';
	import type { ComponentProps } from 'svelte';

	let { checked = false, ...restProps }: ComponentProps<typeof Checkbox> = $props();
</script>

<Checkbox {checked} {...restProps} />
