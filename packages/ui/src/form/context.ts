import type { JsonPatchOperation } from '@norbital-ai/std/json';
import { getContext, setContext } from 'svelte';

export type FieldProps<TValue = unknown> = {
	name: string;
	value: TValue;
	handleChange: (next: TValue) => void;
	handleBlur: () => void;
	errors: string[];
	/** RFC 6902 JSON Patch operations affecting this field */
	delta: JsonPatchOperation[];
	disabled: boolean;
};

/**
 * Field context type (untyped value for context passing)
 */
export type FieldContext = FieldProps<unknown>;

const FIELD_CONTEXT_KEY = Symbol('form-field');

export function setField<TValue>(getter: () => FieldProps<TValue>): void {
	setContext(FIELD_CONTEXT_KEY, getter as () => FieldContext);
}

export function getField(): () => FieldContext {
	return getContext(FIELD_CONTEXT_KEY);
}
