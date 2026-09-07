import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FacilityBinding, FacilityCall } from '@norbital-ai/bolt-protocol';
import { success } from '@norbital-ai/bolt-protocol';
import {
	attributeEscapedFailure,
	guardBinding,
	guardBindings
} from '../src/facilities/boundary.js';

const metadata = { effectId: 'effect-1' } as unknown as FacilityCall;
const signal = new AbortController().signal;
const call = (binding: FacilityBinding<unknown, unknown>) => binding.call(metadata, {}, signal);

/**
 * Nothing a binding does may reach the process. The listeners here are the assertion: a sync throw
 * or a rejection that escaped the boundary would be delivered to them.
 */
describe('facility boundary', () => {
	const processEvents: Array<string> = [];
	const record = (cause: unknown) =>
		processEvents.push(cause instanceof Error ? cause.message : String(cause));
	beforeEach(() => {
		processEvents.length = 0;
		process.on('uncaughtException', record);
		process.on('unhandledRejection', record);
	});
	afterEach(() => {
		process.off('uncaughtException', record);
		process.off('unhandledRejection', record);
	});

	it('answers a binding that throws synchronously as that call\'s failure', async () => {
		const binding = guardBinding('database', {
			call: () => {
				throw new Error('threw before returning a promise');
			}
		});
		const result = await call(binding);
		expect(result).toMatchObject({
			_tag: 'Failure',
			error: { code: 'facility_failure', message: 'database: threw before returning a promise' }
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(processEvents).toEqual([]);
	});

	it('answers a binding that rejects as that call\'s failure', async () => {
		const binding = guardBinding('files', { call: () => Promise.reject(new Error('rejected')) });
		expect(await call(binding)).toMatchObject({
			_tag: 'Failure',
			error: { code: 'facility_failure', message: 'files: rejected' }
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(processEvents).toEqual([]);
	});

	it('answers a binding that resolves to something other than a facility result as a failure', async () => {
		const binding = guardBinding('ai', {
			call: () => Promise.resolve(undefined as never)
		});
		expect(await call(binding)).toMatchObject({
			_tag: 'Failure',
			error: { code: 'facility_failure' }
		});
		const answered = guardBinding('ai', { call: () => Promise.resolve(success({ ok: true })) });
		expect(await call(answered)).toEqual({ _tag: 'Success', value: { ok: true } });
	});

	/**
	 * The incident's shape: the binding returns while a socket it opened is still alive, and that
	 * socket emits `error` with no listener. Node raises it at process level, inside the async
	 * scope of the call that started the socket. The scope is what lets the process policy hand
	 * the failure back to that call instead of treating it as the host's.
	 */
	it('attributes a failure raised later by a socket the binding created to that call and settles it', async () => {
		let attributed: ReturnType<typeof attributeEscapedFailure>;
		const binding = guardBinding<unknown, { answered: boolean }>('connector', {
			call: () =>
				new Promise((resolve) => {
					setImmediate(() => {
						// The process policy runs `attributeEscapedFailure` from Node's handler while
						// the raising callback's async context is still active. The same context is
						// active here, so this is that call site without crashing the test worker.
						attributed = attributeEscapedFailure(new Error('late socket error'));
						resolve(success({ answered: true }));
					});
				})
		});
		const result = await call(binding);
		expect(attributed).toMatchObject({ facility: 'connector', effectId: 'effect-1' });
		expect(result).toMatchObject({
			_tag: 'Failure',
			error: { code: 'facility_failure', message: 'connector: late socket error' }
		});
		expect(attributeEscapedFailure(new Error('outside any facility call'))).toBeUndefined();
		expect(processEvents).toEqual([]);
	});

	it('guards every binding once and passes the scope through', () => {
		const database = { call: () => Promise.resolve(success({})) };
		const scope = { tenantId: 't', environment: 'e', releaseId: 'r' };
		const bindings = guardBindings({ scope, database } as never);
		expect(bindings.scope).toBe(scope);
		expect(bindings.database).not.toBe(database);
		expect(guardBindings(bindings).database).toBe(bindings.database);
	});
});
