<script lang="ts" module>
	import { createContext } from 'svelte';

	type SelectionContextValue = {
		toggleSelection: (value: string) => void;
		isSelected: (value: string) => boolean;
		multiple: () => boolean;
	};

	// Moved types here if possible or just context
	export const [getSelectionCardContext, setSelectionCardContext] =
		createContext<() => SelectionContextValue>();
</script>

<script lang="ts" generics="Multiple extends boolean">
	import { type Snippet } from 'svelte';

	// Define props with generics to handle both single and multiple selection modes
	let {
		multiple = false as Multiple,
		value = $bindable(),
		onValueChange = () => {},
		children
	} = $props<{
		multiple?: Multiple;
		value?: Multiple extends true ? string[] : string | null;
		onValueChange?: (
			value: Multiple extends true ? string[] | undefined : string | undefined
		) => void;
		children: Snippet;
	}>();

	// Initialize value reactively if not provided
	const effectiveValue = $derived(value ?? (multiple ? ([] as string[]) : null));

	// Helper function to determine if a value is selected
	function isSelected(itemValue: string): boolean {
		if (multiple) {
			return Array.isArray(effectiveValue) && effectiveValue.includes(itemValue);
		} else {
			return effectiveValue === itemValue;
		}
	}

	// Handle selection toggling
	function toggleSelection(itemValue: string): void {
		if (multiple) {
			// For multiple selection mode
			if (Array.isArray(effectiveValue) && effectiveValue.includes(itemValue)) {
				// Remove item if already selected
				value = effectiveValue.filter((v) => v !== itemValue) as Multiple extends true
					? string[]
					: string | null;
			} else {
				// Add item if not selected
				value = [
					...(Array.isArray(effectiveValue) ? effectiveValue : []),
					itemValue
				] as Multiple extends true ? string[] : string | null;
			}
		} else {
			// For single selection mode - toggle off if same value, otherwise set new value
			if (effectiveValue === itemValue) {
				value = null as Multiple extends true ? string[] : string | null;
			} else {
				value = itemValue as Multiple extends true ? string[] : string | null;
			}
		}

		// Emit the change event with the appropriate type
		const result =
			value === null || (Array.isArray(value) && value.length === 0) ? undefined : value;

		onValueChange(result as Multiple extends true ? string[] | undefined : string | undefined);
	}

	// Provide context for child components with getter for reactivity
	const context: SelectionContextValue = {
		toggleSelection,
		isSelected,
		multiple: () => multiple as boolean
	};

	// Set context via getter pattern
	setSelectionCardContext(() => context);
</script>

<div class="selection-card-group">
	{@render children()}
</div>
