<script lang="ts">
	// A page whose identity and header actions the shell's hero renders (§3.6 AppShell).
	import { AppShell } from '@norbital-ai/ui/layout';
	let title = $state('Dispatch board');
	let description = $state('Every job due today');
</script>

{#snippet actions()}<button
		type="button"
		data-export
		onclick={() => {
			title = 'Dispatch overview';
			description = 'All jobs this week';
		}}>Export</button
	>{/snippet}
<AppShell icon="lucide:cpu" {title} {description} {actions}>
	<p data-body>body</p>
</AppShell>
