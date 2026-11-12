import { expect, it } from '@effect/vitest';
import { format_metric_value } from '../src/chart/UsageChart.svelte';
it('keeps sub-cent AI charges visible while distinguishing zero and missing usage', () => {
	expect(format_metric_value('micro-SGD', 1)).toBe('$0.000001');
	expect(format_metric_value('micro-SGD', 991)).toBe('$0.000991');
	expect(format_metric_value('micro-SGD', 10_000)).toBe('$0.01');
	expect(format_metric_value('micro-SGD', 0)).toBe('$0.00');
	expect(format_metric_value('micro-SGD', null)).toBe('Unavailable');
});

it('formats metric values in the viewer locale', () => {
	expect(format_metric_value('seconds', 1.5, 'de-DE')).toBe('1,5 s');
	expect(format_metric_value('bytes', 1536, 'de-DE')).toBe('1,5 KiB');
	expect(format_metric_value('seconds', 1.5, 'en-SG')).toBe('1.5 s');
});
