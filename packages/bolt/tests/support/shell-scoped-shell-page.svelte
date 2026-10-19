<script lang="ts">
	// A scoped page showing no view of the collection (a tab not opened yet): only its AppShell offers the scope.
	import { setContext } from 'svelte';
	import { AppShell } from '@norbital-ai/ui/layout';
	setContext(Symbol.for('test.create_scope'), { title: () => 'Scoped lease' });
</script>

<AppShell title="Home"><p>home</p></AppShell>
