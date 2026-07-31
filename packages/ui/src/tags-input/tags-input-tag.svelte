<script lang="ts">
	import { cn } from '#lib/utils';

	type TagColor =
		'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'brown' | 'grey' | 'black';

	let {
		value,
		color = 'grey',
		disabled = false,
		readonly = false,
		isFixed = false,
		isSelected = false, // <-- FIX: Added isSelected prop
		onDelete
	}: {
		value: string | number; // <-- FIX: Allow number for value
		color?: TagColor;
		disabled?: boolean;
		readonly?: boolean;
		isFixed?: boolean;
		isSelected?: boolean; // <-- FIX: Added isSelected type
		onDelete?: () => void;
	} = $props();

	const handleDelete = () => {
		if (!disabled && !readonly && !isFixed && onDelete) {
			onDelete();
		}
	};

	const handleKeydown = (event: KeyboardEvent) => {
		if (event.key === 'Delete' || event.key === 'Backspace') {
			event.preventDefault();
			event.stopPropagation();
			handleDelete();
		}
	};
</script>

<span
	class={cn(
		'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
		'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2',
		{
			'border-yellow-700 bg-yellow-100 text-yellow-700 hover:bg-yellow-200': color === 'yellow',
			'border-red-700 bg-red-100 text-red-700 hover:bg-red-200': color === 'red',
			'border-orange-700 bg-orange-100 text-orange-700 hover:bg-orange-200': color === 'orange',
			'border-green-700 bg-green-100 text-green-700 hover:bg-green-200': color === 'green',
			'border-blue-700 bg-blue-100 text-blue-700 hover:bg-blue-200': color === 'blue',
			'border-purple-700 bg-purple-100 text-purple-700 hover:bg-purple-200': color === 'purple',
			'border-pink-700 bg-pink-100 text-pink-700 hover:bg-pink-200': color === 'pink',
			'border-brown-700 bg-brown-100 text-brown-700 hover:bg-brown-200': color === 'brown',
			'border-gray-700 bg-gray-100 text-gray-700 hover:bg-gray-200': color === 'grey',
			'border-black bg-gray-100 text-black hover:bg-gray-200': color === 'black'
		},
		{
			'opacity-50': disabled,
			'cursor-not-allowed': disabled || readonly,
			'ring-2 ring-blue-500 ring-offset-2': isSelected // <-- FIX: Apply style when selected
		}
	)}
	role="button"
	tabindex={disabled || readonly ? -1 : 0}
	onkeydown={handleKeydown}
	aria-label={`Tag: ${value}${isFixed ? ' (fixed)' : ''}`}
	aria-disabled={disabled || readonly}
>
	<span class="select-none">{String(value)}</span>

	{#if !disabled && !readonly && !isFixed}
		<button
			type="button"
			onmousedown={(event) => {
				event.preventDefault();
				event.stopPropagation();
			}}
			onclick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				handleDelete();
			}}
			class={cn(
				'ml-1 flex h-3 w-3 items-center justify-center rounded-full transition-colors',
				'hover:bg-black/10 focus:bg-black/10 focus:outline-none',
				{
					'hover:bg-yellow-800/20 focus:bg-yellow-800/20': color === 'yellow',
					'hover:bg-red-800/20 focus:bg-red-800/20': color === 'red',
					'hover:bg-orange-800/20 focus:bg-orange-800/20': color === 'orange',
					'hover:bg-green-800/20 focus:bg-green-800/20': color === 'green',
					'hover:bg-blue-800/20 focus:bg-blue-800/20': color === 'blue',
					'hover:bg-purple-800/20 focus:bg-purple-800/20': color === 'purple',
					'hover:bg-pink-800/20 focus:bg-pink-800/20': color === 'pink',
					'hover:bg-brown-800/20 focus:bg-brown-800/20': color === 'brown',
					'hover:bg-gray-800/20 focus:bg-gray-800/20': color === 'grey',
					'hover:bg-black/20 focus:bg-black/20': color === 'black'
				}
			)}
			aria-label="Remove tag"
		>
			<svg
				class="h-2 w-2"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				xmlns="http://www.w3.org/2000/svg"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="3"
					d="M6 18L18 6M6 6l12 12"
				/>
			</svg>
		</button>
	{/if}
</span>
