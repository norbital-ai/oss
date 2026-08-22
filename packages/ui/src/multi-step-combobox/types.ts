import type { Snippet } from 'svelte';
import type { TOption } from '#lib/combobox';
import type {
	CommandClientConfig,
	CommandServerConfig,
	TInfiniteLoadingConfig
} from '#lib/command';

type TStepLabel = string | Snippet<[{ compact: boolean }]>;

export type AnyStepOption<TValueMap extends Record<string, unknown>> = TOption<
	TValueMap[keyof TValueMap],
	{ compact: boolean }
>;

type BuiltinStepDef<TValueMap extends Record<string, unknown>, K extends keyof TValueMap> = {
	type: 'client' | 'server';
	label?: TStepLabel;
	options: TOption<TValueMap[K], { compact: boolean }>[];
	clientConfig?: CommandClientConfig;
	serverConfig?: CommandServerConfig;
	infiniteLoading?: TInfiniteLoadingConfig;
};

type CustomPickerParams<TValueMap extends Record<string, unknown>, K extends keyof TValueMap> = {
	value: TValueMap[K] | undefined;
	onValueChange: (next: TValueMap[K] | undefined) => void;
	selection: Partial<TValueMap>;
};

type CustomStep<TValueMap extends Record<string, unknown>, K extends keyof TValueMap> = {
	type: 'custom';
	label?: TStepLabel;
	render: Snippet<[CustomPickerParams<TValueMap, K>]>;
	formatSelection?: Snippet<[TValueMap[K], { compact: boolean } & Partial<TValueMap>]>;
};

type StepDef<TValueMap extends Record<string, unknown>, K extends keyof TValueMap> =
	BuiltinStepDef<TValueMap, K> | CustomStep<TValueMap, K>;

export type StepsConfig<TValueMap extends Record<string, unknown>> = {
	[K in keyof TValueMap]: StepDef<TValueMap, K>;
};

export type SelectionDraft<TValueMap extends Record<string, unknown>> = Partial<TValueMap>;
