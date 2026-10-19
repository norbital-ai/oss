<script lang="ts">
	// A page that hands its create scope to the forms it opens through a context (hr's HR_CREATE_SCOPE), and a Table's New.
	import { setContext } from 'svelte';
	import { Table } from '@norbital-ai/ui';
	setContext(Symbol.for('test.create_scope'), { title: () => 'Scoped lease' });
</script>

<Table of="docs" columns={['title']} />
