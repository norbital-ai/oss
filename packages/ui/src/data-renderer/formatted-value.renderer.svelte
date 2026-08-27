<script lang="ts">
	import type { FieldRendererProps } from './data-renderer.types.js';

	export interface FormattedValueRendererProps extends FieldRendererProps {
		format: (context: {
			field: FieldRendererProps['field'];
			value: FieldRendererProps['value'];
			// Svelte erases the parent table/form row generic when a component value crosses through
			// `renderer={...}`. Keep this callback bivariant at that boundary so authored formatters may
			// recover their generated row type; the router still supplies the row and owns mutation.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			row: any;
		}) => string | number | null | undefined;
	}

	let {
		field,
		value,
		row,
		placeholder = '—',
		format,
		class: className
	}: FormattedValueRendererProps = $props();
	const formatted = $derived(format({ field, value, row }));
	const displayed = $derived(
		formatted == null || formatted === '' ? placeholder : String(formatted)
	);
</script>

<span class={['block min-w-0 truncate', className]} title={displayed}>{displayed}</span>
