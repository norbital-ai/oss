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

export type ChartDisplayConfigEntry = {
	label?: string;
	color?: string;
};

export type ChartDisplayConfig = Record<string, ChartDisplayConfigEntry>;

export type ChartDisplayValueFormat = {
	style: 'number' | 'percent' | 'currency';
	currency?: string;
	maximumFractionDigits?: number;
	minimumFractionDigits?: number;
};

export type CartesianChartDatum = Record<string, ChartDisplayValue>;

export type DonutChartDatum = {
	key: string;
	value: number;
};

export type BaseChartSpec = {
	title?: string;
	description?: string;
	loading?: boolean;
	config: ChartDisplayConfig;
	showGrid?: boolean;
	valueFormat?: ChartDisplayValueFormat;
};

export type CartesianChartSpec = BaseChartSpec & {
	kind: 'bar' | 'line' | 'area';
	data: CartesianChartDatum[];
	xKey: string;
	series: string[];
	stacked?: boolean;
	curve?: 'linear' | 'natural' | 'step';
	xAxisLabelRotation?: number;
};

export type DonutChartSpec = BaseChartSpec & {
	kind: 'donut';
	data: DonutChartDatum[];
	innerRadius?: number;
};

export type ChartDisplaySpec = CartesianChartSpec | DonutChartSpec;

export type TooltipPayload = Tooltip.TooltipSeries;

// Helper to extract item config from a payload.
export function getPayloadConfigFromPayload(
	config: ChartConfig,
	payload: TooltipPayload,
	key: string
) {
	if (typeof payload !== 'object' || payload === null) return undefined;

	let configLabelKey: string = key;

	if (payload.key === key) {
		configLabelKey = payload.key;
	} else if (payload.label === key) {
		configLabelKey = payload.label;
	} else if (key in payload && typeof payload[key as keyof typeof payload] === 'string') {
		configLabelKey = payload[key as keyof typeof payload] as string;
	}

	return configLabelKey in config ? config[configLabelKey] : config[key as keyof typeof config];
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
