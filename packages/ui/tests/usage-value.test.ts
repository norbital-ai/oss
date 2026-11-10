import { expect, it } from '@effect/vitest';
import { formatMetricValue } from '../src/chart/UsageChart.svelte';
it('keeps sub-cent AI charges visible while distinguishing zero and missing usage', () => {
	expect(formatMetricValue('micro-SGD', 1)).toBe('$0.000001');
	expect(formatMetricValue('micro-SGD', 991)).toBe('$0.000991');
	expect(formatMetricValue('micro-SGD', 10_000)).toBe('$0.01');
	expect(formatMetricValue('micro-SGD', 0)).toBe('$0.00');
	expect(formatMetricValue('micro-SGD', null)).toBe('Unavailable');
});

it('formats metric values in the viewer locale', () => {
	expect(formatMetricValue('seconds', 1.5, 'de-DE')).toBe('1,5 s');
	expect(formatMetricValue('bytes', 1536, 'de-DE')).toBe('1,5 KiB');
	expect(formatMetricValue('seconds', 1.5, 'en-SG')).toBe('1.5 s');
});
