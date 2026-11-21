<script lang="ts">
	import { Option, Schema } from 'effect';
	import type { ShellPageContext } from '../../src/shell/runtime.ts';

	const OrdersAnswer = Schema.Struct({
		orders: Schema.Struct({
			rows: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, amount: Schema.Number })),
			next: Schema.NullOr(Schema.String),
			total: Schema.Number
		})
	});
	const decodeOrders = Schema.decodeUnknownOption(OrdersAnswer);

	let { ctx }: { ctx: ShellPageContext } = $props();
	// svelte-ignore state_referenced_locally
	const orders = ctx.query({
		orders: { fields: ['id', 'title', 'amount'] }
	});
	const decoded = $derived(decodeOrders(orders.current));
</script>

<section data-testid="perf-orders-page">
	<h1>Orders</h1>
	{#if Option.isSome(decoded)}
		<p data-testid="orders-count">{decoded.value.orders.rows.length}</p>
		<p data-testid="orders-latest">{decoded.value.orders.rows.at(-1)?.title ?? ''}</p>
	{:else if orders.error}
		<p data-testid="orders-error">{orders.error.message}</p>
	{:else}
		<p data-testid="orders-loading">Loading {JSON.stringify(orders.current ?? null)}</p>
	{/if}
</section>
