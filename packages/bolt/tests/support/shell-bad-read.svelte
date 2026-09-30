<script lang="ts">
	// A page whose live table asks for a malformed refresh (`every: '1m'`, not a duration): the host refuses the read as
	// `invalid`, which a browser shows only as the view's error text — no console error, no throw.
	import { AppShell } from '@norbital-ai/ui/layout';
	import { Table } from '@norbital-ai/ui';
</script>

<AppShell icon="lucide:cpu" title="Docs" description="Every document">
	<Table of={'docs' as never} every="1m" columns={['title'] as never} />
</AppShell>
