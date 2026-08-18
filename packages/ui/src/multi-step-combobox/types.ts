import type { Snippet } from 'svelte';
import type { TOption } from '#lib/combobox';
import type {
	CommandClientConfig,
	CommandServerConfig,
	TInfiniteLoadingConfig
} from '#lib/command';

export type TStepLabel = string | Snippet<[{ compact: boolean }]>;

export type AnyStepOption<TValueMap extends Record<string, unknown>> = TOption<
	TValueMap[keyof TValueMap],
	{ compact: boolean }
>;

export type BuiltinStepDef<TValueMap extends Record<string, unknown>, K extends keyof TValueMap> = {
	type: 'client' | 'server';
	label?: TStepLabel;
	options: TOption<TValueMap[K], { compact: boolean }>[];
	clientConfig?: CommandClientConfig;
	serverConfig?: CommandServerConfig;
	infiniteLoading?: TInfiniteLoadingConfig;
};

export type CustomPickerParams<
	TValueMap extends Record<string, unknown>,
	K extends keyof TValueMap
> = {
	value: TValueMap[K] | undefined;
	onValueChange: (next: TValueMap[K] | undefined) => void;
	selection: Partial<TValueMap>;
};

export type CustomStep<TValueMap extends Record<string, unknown>, K extends keyof TValueMap> = {
	type: 'custom';
	label?: TStepLabel;
	render: Snippet<[CustomPickerParams<TValueMap, K>]>;
	formatSelection?: Snippet<[TValueMap[K], { compact: boolean } & Partial<TValueMap>]>;
};

export type StepDef<TValueMap extends Record<string, unknown>, K extends keyof TValueMap> =
	BuiltinStepDef<TValueMap, K> | CustomStep<TValueMap, K>;

export type StepsConfig<TValueMap extends Record<string, unknown>> = {
	[K in keyof TValueMap]: StepDef<TValueMap, K>;
};

export type SelectionDraft<TValueMap extends Record<string, unknown>> = Partial<TValueMap>;

export type TOutputValue<
	TValueMap extends Record<string, unknown>,
	M extends boolean
> = M extends true ? TValueMap[] : TValueMap;

export type TLocalState<
	TValueMap extends Record<string, unknown>,
	M extends boolean
> = M extends true ? SelectionDraft<TValueMap>[] : SelectionDraft<TValueMap> | null;

export type TMultiStepComboboxProps<
	TValueMap extends Record<string, unknown>,
	TMultiple extends boolean = false
> = {
	steps: StepsConfig<TValueMap>;
	value?: TOutputValue<TValueMap, TMultiple> | null;
	onValueChange?: (value: TOutputValue<TValueMap, TMultiple> | null) => void;
	onSelectionChange?: (selection: Partial<TValueMap>) => void;
	multiple?: TMultiple;
	display?: Snippet<[TOutputValue<TValueMap, TMultiple> | null]>;
	emptyPlaceholder?: string | Snippet;
	disabled?: boolean;
	class?: string;
	sameWidth?: boolean;
	dropdownClass?: string;
	align?: 'start' | 'center' | 'end';
	allowClear?: boolean;
	hideChevron?: boolean;
	style?: string;
	itemHeight?: number;
	maxHeight?: number;
	overscan?: number;
	stepSeparator?: string;
	entityName?: string;
	panelHeight?: number;
	ariaLabelSelections?: string;
	ariaLabelList?: string;
};
