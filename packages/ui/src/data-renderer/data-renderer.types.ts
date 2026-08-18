import type { CollectionField } from '@norbital-ai/std/collection';

export interface DataRendererProps {
	field: CollectionField;
	value: unknown;
	id?: string;
	mode?: 'display' | 'edit';
	disabled?: boolean;
	placeholder?: string;
	onValueChange?: (value: unknown) => void;
	/** Full matrix/form row when the renderer needs sibling fields. */
	row?: Record<string, unknown>;
	onRowChange?: (patch: Record<string, unknown>) => void;
	locale?: string;
	class?: string;
}
