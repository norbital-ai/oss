import type { Snippet } from 'svelte';

// types.ts
type RatingGroupItemState = 'active' | 'partial' | 'inactive';

export interface StarRatingStarProps {
	index: number;
	state: RatingGroupItemState;
	class?: string;
	disabled?: boolean;
}
export interface StarRatingRootProps {
	value?: number;
	max?: number;
	disabled?: boolean;
	readonly?: boolean;
	required?: boolean;
	allowHalf?: boolean;
	hoverPreview?: boolean;
	orientation?: 'horizontal' | 'vertical';
	min?: number;
	name?: string;
	class?: string;
	onValueChange?: (value: number) => void;
	children?: Snippet<
		[
			{
				items: Array<{
					index: number;
					state: RatingGroupItemState;
				}>;
				value: number;
				max: number;
			}
		]
	>;
}
