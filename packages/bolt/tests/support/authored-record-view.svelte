<!-- A template's own record view: it reads the page context a page receives (clock, translator, reads). -->
<script lang="ts">
	import type { RecordView } from '@norbital-ai/ui';
	import type { PageContext } from '../../src/page/index.ts';
	let { view, ctx }: { view: RecordView; ctx: PageContext } = $props();
	// svelte-ignore state_referenced_locally
	const today = ctx.clock('day').today;
	// svelte-ignore state_referenced_locally
	const all = ctx.query({ products: { fields: ['name'] } });
</script>

<p data-testid="authored-view">
	{ctx.t('Product')}: {view.mode}, {today}, {all.current?.products.rows.length ?? 'loading'}
</p>
