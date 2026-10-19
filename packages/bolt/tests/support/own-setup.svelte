<!-- A definition's own `integration/<name>/+integration.svelte`, as the setup tests mount it. -->
<script lang="ts">
	import type { IntegrationSetupProps } from '../../src/shell/integration/setup.ts';
	let { instance }: IntegrationSetupProps = $props();
</script>

<p data-own-connect>{instance}</p>
