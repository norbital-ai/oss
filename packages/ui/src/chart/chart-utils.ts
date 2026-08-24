import { Schema } from 'effect';
import type { Tooltip } from 'layerchart';
import { getContext, setContext, type Component } from 'svelte';

export const THEMES = { light: '', dark: '.dark' } as const;

export type ChartConfig = {
	[k in string]: {
		label?: string;
		icon?: Component;
	} & (
		| { color?: string; theme?: never }
		| { color?: never; theme: Record<keyof typeof THEMES, string> }
	);
};

export type ChartDisplayValue = string | number | null;

const ChartDisplayConfigEntrySchema = Schema.Struct({
	label: Schema.optional(Schema.String),
	color: Schema.optional(Schema.String)
});
export type ChartDisplayConfigEntry = typeof ChartDisplayConfigEntrySchema.Type;

const ChartDisplayConfigSchema = Schema.Record(Schema.String, ChartDisplayConfigEntrySchema);
export type ChartDisplayConfig = typeof ChartDisplayConfigSchema.Type;

const ChartDisplayValueFormatSchema = Schema.Struct({
	style: Schema.Literals(['number', 'percent', 'currency']),
	currency: Schema.optional(Schema.String),
	maximumFractionDigits: Schema.optional(Schema.Number),
	minimumFractionDigits: Schema.optional(Schema.Number)
});
export type ChartDisplayValueFormat = typeof ChartDisplayValueFormatSchema.Type;

type CartesianChartDatum = Record<string, ChartDisplayValue>;

const DonutChartDatumSchema = Schema.Struct({
	key: Schema.String,
	value: Schema.Number
});
type DonutChartDatum = typeof DonutChartDatumSchema.Type;

const BaseChartSpecSchema = Schema.Struct({
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
	loading: Schema.optional(Schema.Boolean),
	config: ChartDisplayConfigSchema,
	showGrid: Schema.optional(Schema.Boolean),
	valueFormat: Schema.optional(ChartDisplayValueFormatSchema)
});
type BaseChartSpec = typeof BaseChartSpecSchema.Type;

type CartesianChartSpec = BaseChartSpec & {
	kind: 'bar' | 'line' | 'area';
	data: CartesianChartDatum[];
	xKey: string;
	series: string[];
	stacked?: boolean;
	curve?: 'linear' | 'natural' | 'step';
	xAxisLabelRotation?: number;
};

type DonutChartSpec = BaseChartSpec & {
	kind: 'donut';
	data: DonutChartDatum[];
	innerRadius?: number;
};

export type ChartDisplaySpec = CartesianChartSpec | DonutChartSpec;

// Helper to extract item config from a payload.
export function getPayloadConfigFromPayload(
	config: ChartConfig,
	payload: Tooltip.TooltipSeries,
	key: string
) {
	if (typeof payload !== 'object' || payload === null) return undefined;

	let configLabelKey: string = key;

	if (payload.key === key) {
		configLabelKey = payload.key;
	} else if (payload.label === key) {
		configLabelKey = payload.label;
	} else {
		const payloadValue = Reflect.get(payload, key);
		if (typeof payloadValue === 'string') configLabelKey = payloadValue;
	}

	return Object.hasOwn(config, configLabelKey)
		? config[configLabelKey]
		: config[key as keyof typeof config];
}

type ChartContextValue = {
	config: ChartConfig;
};

const chartContextKey = Symbol('chart-context');

export function setChartContext(value: ChartContextValue) {
	return setContext(chartContextKey, value);
}

export function useChart() {
	return getContext<ChartContextValue>(chartContextKey);
}
