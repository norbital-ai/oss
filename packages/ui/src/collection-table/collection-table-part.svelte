<script module lang="ts">
	import { createContext } from 'svelte';

	interface CollectionTablePartContext {
		setColumn: (token: object, column: unknown) => void;
		removeColumn: (token: object) => void;
	}

	export const [getCollectionTablePartContext, setCollectionTablePartContext] =
		createContext<CollectionTablePartContext>();
</script>

<script lang="ts" generics="TRow extends object">
	import { onMount } from 'svelte';
	import type { CollectionTableColumnPrimitiveProps } from '#lib/collection-table/collection-table.types';

	type Props = CollectionTableColumnPrimitiveProps<TRow>;

	let props: Props = $props();
	const context = getCollectionTablePartContext();
	const token = {};

	// Register once. Getters keep authored props live when the parent derives its grid columns,
	// without a watch that writes back into the same parent registry and rerenders this component.
	const column = {
		get key() {
			return props.name;
		},
		get label() {
			return props.label;
		},
		get width() {
			return props.width;
		},
		get minWidth() {
			return props.minWidth;
		},
		get maxWidth() {
			return props.maxWidth;
		},
		get sortable() {
			return props.sortable;
		},
		get resizable() {
			return props.resizable;
		},
		get hideable() {
			return props.hideable;
		},
		get pinnable() {
			return props.pinnable;
		},
		get card() {
			return props.card;
		},
		get render() {
			return props.render;
		}
	};

	onMount(() => {
		context.setColumn(token, column);
		return () => context.removeColumn(token);
	});
</script>
