import type { CollectionField } from '@norbital-ai/std/collection';

const bounds: Readonly<Record<string, readonly [number, number]>> = {
	boolean: [72, 112],
	clock_time: [96, 144],
	date: [120, 168],
	timestamp: [168, 240],
	timestamptz: [168, 240],
	datetime: [168, 240],
	money: [120, 184],
	numeric: [88, 168],
	number: [88, 168],
	integer: [80, 144],
	enum: [104, 224],
	file: [144, 288],
	uuid: [160, 288],
	text: [120, 360],
	string: [120, 360],
	phone: [128, 208]
};

export function fitCollectionColumnWidth(
	field: CollectionField,
	formattedValues: readonly string[],
	header: string,
	measure: (text: string) => number = (text) => text.length * 7.5
): number {
	const [kindMin, kindMax] = field.relation ? [144, 288] : (bounds[field.kind] ?? [120, 320]);
	const widest = Math.max(
		measure(header) + 64,
		...formattedValues.map((value) => measure(value) + 32)
	);
	return Math.ceil(Math.max(kindMin, Math.min(kindMax, widest)));
}
