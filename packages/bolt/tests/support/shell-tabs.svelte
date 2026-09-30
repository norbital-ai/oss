<script lang="ts">
	// A page with its own Tabs: under the shell's pages strip they are level 2, never a second level-1 bar (A8).
	import { Tabs } from '@norbital-ai/ui';
</script>

{#snippet a()}<p data-body>a</p>{/snippet}
{#snippet b()}<p>b</p>{/snippet}
<Tabs tabs={[{ name: 'a', title: 'A', body: a }, { name: 'b', title: 'B', body: b }]} />
