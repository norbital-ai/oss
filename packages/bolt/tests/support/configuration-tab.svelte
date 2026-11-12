<script lang="ts">
	import type { ShellPageContext } from '../../src/shell/runtime.ts';
	let { ctx }: { ctx: ShellPageContext } = $props();
</script>

<p>Tab reads {typeof ctx.query}</p>
