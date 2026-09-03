import { describe, expect, it } from 'vitest';
import { syncControlUrlOf } from '../src/client/runtime.js';

describe('syncControlUrlOf', () => {
	it('rewrites a bare stream path', () => {
		expect(syncControlUrlOf('/__bolt/sync/stream', 'connect')).toBe('/__bolt/sync/connect');
		expect(syncControlUrlOf('/__bolt/sync/stream', 'extend')).toBe('/__bolt/sync/extend');
	});

	it('keeps a headed session query on connect and extend', () => {
		const stream = '/__bolt/sync/stream?norbital_headed=session-1';
		expect(syncControlUrlOf(stream, 'connect')).toBe(
			'/__bolt/sync/connect?norbital_headed=session-1'
		);
		expect(syncControlUrlOf(stream, 'extend')).toBe(
			'/__bolt/sync/extend?norbital_headed=session-1'
		);
	});

	it('keeps the query on an absolute stream URL', () => {
		expect(
			syncControlUrlOf('http://127.0.0.1:9/__bolt/sync/stream?norbital_headed=s', 'connect')
		).toBe('http://127.0.0.1:9/__bolt/sync/connect?norbital_headed=s');
	});
});
