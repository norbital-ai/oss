import { Schema } from 'effect';
import type { CollectionField } from '@norbital-ai/std/collection';
import { humanize } from '@norbital-ai/std/string';

const derivedLaneSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	color: Schema.optionalKey(Schema.String)
});
type DerivedLane = typeof derivedLaneSchema.Type;

const authoredLaneSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.optionalKey(Schema.String),
	color: Schema.optionalKey(Schema.String)
});
type AuthoredLane = typeof authoredLaneSchema.Type;
export type AuthoredLaneInput = string | AuthoredLane;

const isString = Schema.is(Schema.String);

function normalizeAuthoredLane(lane: AuthoredLaneInput): AuthoredLane {
	return isString(lane)
		? { value: lane }
		: { value: String(lane.value), label: lane.label, color: lane.color };
}

export function parseAuthoredLaneValues(lanes: readonly AuthoredLaneInput[]): string[] {
	return lanes.map((lane) => normalizeAuthoredLane(lane).value);
}

export function deriveLanes(field: CollectionField | undefined): DerivedLane[] {
	return field?.values?.map((value) => ({ value, label: humanize(value) })) ?? [];
}

export function mergeAuthoredLanes(
	derived: readonly DerivedLane[],
	authored?: readonly AuthoredLaneInput[]
): Map<string, DerivedLane> {
	const metadata = new Map(derived.map((lane) => [lane.value, lane]));
	if (!authored?.length) return metadata;
	for (const entry of authored) {
		const lane = normalizeAuthoredLane(entry);
		const existing = metadata.get(lane.value);
		metadata.set(lane.value, {
			value: lane.value,
			label: lane.label ?? existing?.label ?? humanize(lane.value),
			color: lane.color ?? existing?.color
		});
	}
	return metadata;
}
