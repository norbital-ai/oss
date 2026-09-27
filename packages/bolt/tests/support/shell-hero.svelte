<script lang="ts">
	// A page whose identity and header actions the shell's hero renders (§3.6 AppShell).
	import { AppShell } from '@norbital-ai/ui/layout';
</script>

{#snippet actions()}<button type="button" data-export>Export</button>{/snippet}
<AppShell icon="lucide:cpu" title="Dispatch board" description="Every job due today" {actions}>
	<p data-body>body</p>
</AppShell>
