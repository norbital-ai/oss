<script module lang="ts">
	import { createContext } from 'svelte';

	interface CollectionKanbanPartContext {
		setField: (token: object, field: unknown) => void;
		removeField: (token: object) => void;
	}

	export const [getCollectionKanbanPartContext, setCollectionKanbanPartContext] =
		createContext<CollectionKanbanPartContext>();
</script>

<script lang="ts" generics="TRow extends object">
	import { onDestroy } from 'svelte';
	import type { CollectionKanbanFieldPrimitiveProps } from './collection-kanban.types';

	let props: CollectionKanbanFieldPrimitiveProps<TRow> = $props();
	const context = getCollectionKanbanPartContext();
	const token = {};
	const field = {
		get key() {
			return props.name;
		},
		get card() {
			return props.card;
		},
		get renderer() {
			return props.renderer;
		},
		get rendererProps() {
			return props.rendererProps;
		},
		get relationOptions() {
			return props.relationOptions;
		}
	};

	context.setField(token, field);
	onDestroy(() => context.removeField(token));
</script>
