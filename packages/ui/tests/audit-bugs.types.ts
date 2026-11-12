// Type-level reproduction for Bolt audit bug 42, checked by `svelte-check --tsconfig tests/tsconfig.json`: two kind
// inputs each export their props under their own name.
import type { TimeOfDayRangeInputProps } from '../src/kinds/time-of-day-range-input.svelte';
import type { TimeRangeInputProps } from '../src/kinds/time-range-input.svelte';

export type KindRangeProps = readonly [TimeOfDayRangeInputProps, TimeRangeInputProps];
// @ts-expect-error the time-of-day input does not reuse the period input's props name
export type Shadowed = import('../src/kinds/time-of-day-range-input.svelte').TimeRangeInputProps;
