/**
 * Generic Tags Input Component for Svelte 5
 *
 * A flexible, type-safe tags input component that supports any data type and all HTML input types.
 * Features include keyboard navigation, validation, fixed tags, and customizable display.
 *
 * @example
 * // Basic string tags
 * <TagsInput bind:value={tags} placeholder="Enter tags..." />
 *
 * @example
 * // Number tags with validation
 * <TagsInput<number>
 *   bind:value={numbers}
 *   type="number"
 *   placeholder="Enter numbers..."
 *   validate={(val) => val > 0 ? val : undefined}
 * />
 *
 * @example
 * // Colored tags
 * <ColoredTagsInput
 *   bind:value={coloredTags}
 *   enableColorSelection={true}
 *   placeholder="Enter colored tags..."
 * />
 */

// ================================
// TYPE DEFINITIONS
// ================================

import type { HTMLInputAttributes } from 'svelte/elements';
import { Schema } from 'effect';

/**
 * Available tag colors
 */
const TagColorSchema = Schema.Literals([
	'red',
	'orange',
	'yellow',
	'green',
	'blue',
	'purple',
	'pink',
	'brown',
	'grey',
	'black'
]);
export type TagColor = typeof TagColorSchema.Type;

/**
 * Colored tag type
 */
const ColoredTagSchema = Schema.Struct({
	value: Schema.String,
	color: TagColorSchema
});
export type ColoredTag = typeof ColoredTagSchema.Type;

/**
 * Configuration for different HTML input types
 */
type InputTypeValue = string | number;

interface InputTypeConfig {
	/** Function to parse string input into the target type */
	parse: (value: string) => InputTypeValue | undefined;
	/** Function to convert the type back to string for display */
	display: (value: InputTypeValue) => string;
	/** Default validation for this input type */
	validate?: (value: InputTypeValue, existing: InputTypeValue[]) => boolean;
}

/**
 * Props for the ColoredTagsInput component
 */
export interface ColoredTagsInputProps extends Omit<HTMLInputAttributes, 'value' | 'type'> {
	/** Array of colored tag values */
	value?: ColoredTag[];

	/** CSS class name */
	class?: string;

	/** Maximum number of tags allowed */
	maxTags?: number;

	/** Placeholder text when no tags exist */
	placeholder?: string;

	/** Whether the input is disabled */
	disabled?: boolean;

	/** Whether the input is readonly */
	readonly?: boolean;

	/** HTML input type (defaults to text for colored tags) */
	type?: string;

	/** Callback when values change */
	onValueChange?: (values: ColoredTag[]) => void;

	/** Custom validation function - return undefined for invalid values */
	validate?: (value: ColoredTag, existing: ColoredTag[]) => ColoredTag | undefined;

	/** Custom parser for converting string input to colored tag value */
	parseValue?: (input: string) => string | undefined;

	/** Custom display formatter for colored tags */
	displayValue?: (value: ColoredTag) => string;

	/** A tag that cannot be deleted */
	fixedTag?: ColoredTag;

	/** Maximum number of visible tags (shows "+N more" for overflow) */
	maxVisible?: number;

	/** Enable color selection interface after validation */
	enableColorSelection?: boolean;
}

// ================================
// INPUT TYPE CONFIGURATIONS
// ================================

/**
 * Built-in configurations for common HTML input types
 */
export const INPUT_TYPE_CONFIGS: Record<string, InputTypeConfig> = {
	text: {
		parse: (val: string) => val.trim() || undefined,
		display: (val) => String(val)
	},

	number: {
		parse: (val: string) => {
			const num = Number(val.trim());
			return isNaN(num) ? undefined : num;
		},
		display: (val) => String(val),
		validate: (val) => typeof val === 'number' && Number.isFinite(val)
	},

	email: {
		parse: (val: string) => {
			const email = val.trim().toLowerCase();
			const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
			return emailRegex.test(email) ? email : undefined;
		},
		display: (val) => String(val)
	},

	tel: {
		parse: (val: string) => {
			const phone = val.trim().replace(/\D/g, '');
			return phone.length >= 10 ? phone : undefined;
		},
		display: (val) => String(val)
	},

	url: {
		parse: (val: string) => {
			const url = val.trim();
			return URL.canParse(url.startsWith('http') ? url : `https://${url}`) ? url : undefined;
		},
		display: (val) => String(val)
	},

	date: {
		parse: (val: string) => {
			const date = new Date(val.trim());
			return isNaN(date.getTime()) ? undefined : date.toISOString().split('T')[0];
		},
		display: (val) => String(val)
	},

	time: {
		parse: (val: string) => {
			const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
			const time = val.trim();
			return timeRegex.test(time) ? time : undefined;
		},
		display: (val) => String(val)
	}
};
