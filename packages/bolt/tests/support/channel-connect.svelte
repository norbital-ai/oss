<!-- A workspace's own `+<name>.connect.svelte` for a custom channel, as the setup tests mount it. -->
<script lang="ts">
	import type { ConnectProps } from '../../src/shell/channels/connect.ts';
	let { channel }: ConnectProps = $props();
</script>

<p data-own-connect>{channel}</p>
