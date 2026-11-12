// Declaration descriptors use catalogue text. Standalone UI kinds retain their own presentation options.
import { Schema } from 'effect';
import { KindSchema, OutputKindSchema, type OutputKind } from '@norbital-ai/std/kind';

const catalogue_text = (kind: OutputKind): boolean => {
	if (kind.label !== undefined || kind.help !== undefined) return false;
	switch (kind.kind) {
		case 'json':
			return kind.shape === undefined || catalogue_text(kind.shape);
		case 'object':
			return Object.values(kind.fields).every(catalogue_text) &&
				(kind.rest === undefined || catalogue_text(kind.rest));
		case 'record':
			return catalogue_text(kind.of);
		case 'union':
			return 'of' in kind ? kind.of.every(catalogue_text) :
				Object.values(kind.arms).every((fields) => Object.values(fields).every(catalogue_text));
		default:
			return true;
	}
};
const text_from_catalogue = Schema.makeFilter((kind: OutputKind) =>
	catalogue_text(kind) ? undefined : 'Declaration field label and help text belong in the message catalogue.');
export const FieldData = KindSchema.check(text_from_catalogue);
export const OutputData = OutputKindSchema.check(text_from_catalogue);
