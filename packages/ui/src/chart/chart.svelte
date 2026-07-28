<script lang="ts">
	import { Display as ChartDisplay } from '#lib/chart';
	import type { ChartDisplaySpec } from '#lib/chart';
	import { cn } from '#lib/utils';

	type Props = {
		spec: ChartDisplaySpec;
		class?: string;
	};

	let { spec, class: className }: Props = $props();
</script>

<ChartDisplay {spec} class={cn('min-h-[240px]', className)} />
