<script module lang="ts">
	import { createContext } from 'svelte';
	import type { CollectionToolbarFilterDeclaration } from './collection-toolbar.types.js';

	interface CollectionToolbarFilterContext {
		setFilter: (token: object, filter: CollectionToolbarFilterDeclaration) => void;
		removeFilter: (token: object) => void;
	}

	export const [getCollectionToolbarFilterContext, setCollectionToolbarFilterContext] =
		createContext<CollectionToolbarFilterContext>();
</script>

<script lang="ts" generics="TValue extends string">
	import { onMount } from 'svelte';
	import type { CollectionToolbarFilterProps } from './collection-toolbar.types.js';

	let props: CollectionToolbarFilterProps<TValue> = $props();
	const context = getCollectionToolbarFilterContext();
	const token = {};

	// Declaration only: the toolbar renders the control, so every surface's derived filters look and
	// behave the same. Getters keep the authored props live without a watch writing back into the
	// registry that owns this component.
	const declaration: CollectionToolbarFilterDeclaration = {
		get id() {
			return props.id;
		},
		get label() {
			return props.label;
		},
		get options() {
			return props.options;
		},
		get value() {
			return props.value;
		},
		get placeholder() {
			return props.placeholder;
		},
		get searchPlaceholder() {
			return props.searchPlaceholder;
		},
		get searchable() {
			return props.searchable;
		},
		change(value) {
			props.onValueChange(value as TValue | null); // stupidity: boundary-cast — a control only ever emits one of the options this declaration published.
		}
	};

	onMount(() => {
		context.setFilter(token, declaration);
		return () => context.removeFilter(token);
	});
</script>
