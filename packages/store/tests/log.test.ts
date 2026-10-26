import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { it, expect } from '@effect/vitest';
import { Effect } from 'effect';
import { logDdl, logStatements, type AppendOnlyLogSpec, type Json } from '../src/index.ts';
import { exec, script } from './support.ts';

const declaration: AppendOnlyLogSpec = {
	format: 1,
	namespace: 'event_log',
	scope: ['partition', 'tenant', 'environment'],
	retirement: true,
	retention: { days: 30, batch: 2 },
	envelope: {
		id: ['id'],
		at: ['at'],
		payload: ['payload'],
		required: ['id', 'at', 'operation', 'status', 'payload'],
		nonempty: [['operation']],
		objects: [],
		enums: [{ path: ['status'], values: ['prepared', 'committed', 'unknown'] }]
	},
	indexes: [{ name: 'by_status', paths: [['status']] }],
	pending: {
		status: ['status'],
		operation: ['operation'],
		prepared: 'prepared',
		unresolved: ['prepared', 'unknown'],
		terminalSuffix: ':terminal'
	}
};
const event = (id: string, status: string, payload: Json = {}): Json => ({
	id,
	at: '2000-01-01T00:00:00.000Z',
	operation: 'one',
	status,
	payload
});

it.live(
	'enforces idempotent immutable append, bounded retention and durable retirement with scoped search',
	() =>
		Effect.gen(function* () {
			const pg = yield* Effect.acquireRelease(
				Effect.promise(() => PGlite.create({ extensions: { pg_trgm } })),
				(pg) => Effect.promise(() => pg.close())
			);
			for (const text of yield* logDdl(declaration)) yield* script(pg, `${text};`);
			const commands = yield* logStatements(declaration),
				execute = exec(pg),
				scope = ['p', 't', 'live'];
			for (const tenant of ['a', 'b'])
				yield* execute(yield* commands.append(['p', tenant, 'live'], [event(tenant, 'committed')]));
			yield* execute(
				yield* commands.append(['other', 'foreign', 'live'], [event('foreign', 'committed')])
			);
			expect(yield* execute(yield* commands.tenants('p'))).toEqual([
				{ tenant: 'a' },
				{ tenant: 'b' }
			]);
			const first = event('one:prepared', 'prepared', { text: `${'x'.repeat(17_000)}100%_match` });
			yield* execute(yield* commands.append(scope, [first]));
			expect(yield* execute(yield* commands.tenants('p', 'b'))).toEqual([{ tenant: 't' }]);
			yield* execute(yield* commands.append(scope, [first]));
			expect(
				yield* execute(yield* commands.query(scope, { limit: 1, text: '100%_match' }))
			).toHaveLength(1);
			expect(
				yield* execute(yield* commands.query(['p', 'other', 'live'], { limit: 1 }))
			).toHaveLength(0);
			// One conflicting id rolls back every append in its native statement.
			const conflict = yield* Effect.exit(
				execute(
					yield* commands.append(scope, [
						event('rolled-back', 'committed'),
						event('one:prepared', 'prepared', 'changed')
					])
				)
			);
			expect(conflict._tag).toBe('Failure');
			expect(yield* execute(yield* commands.detail(scope, 'rolled-back'))).toHaveLength(0);
			expect(yield* execute(yield* commands.pending(scope, { limit: 1 }))).toHaveLength(1);
			yield* execute(yield* commands.append(scope, [event('one:terminal', 'committed')]));
			expect(yield* execute(yield* commands.pending(scope, { limit: 1 }))).toHaveLength(0);
			for (const text of [
				"UPDATE event_log.event SET event='{}'",
				'DELETE FROM event_log.event',
				'TRUNCATE event_log.event'
			])
				expect((yield* Effect.exit(execute({ text, params: [] })))._tag).toBe('Failure');
			// Old occurrence time is retained: only the native recording time controls expiry.
			expect((yield* execute(yield* commands.expire('p')))[0]?.['removed']).toBe(0);
			for (const id of ['expired-one', 'expired-two', 'expired-three'])
				yield* execute({
					text: `INSERT INTO event_log.event(partition,tenant,environment,id,occurred_at,recorded_at,event)
			VALUES($1,$2,$3,$4,$5::timestamptz,clock_timestamp()-interval '31 days',$6::jsonb)`,
					params: [...scope, id, '2000-01-01T00:00:00.000Z', JSON.stringify(event(id, 'committed'))]
				});
			expect((yield* execute(yield* commands.expire('p')))[0]?.['removed']).toBe(2);
			expect((yield* execute(yield* commands.expire('p')))[0]?.['removed']).toBe(1);
			yield* execute(yield* commands.retire(['p', 't']));
			expect((yield* execute(yield* commands.isRetired(['p', 't'])))[0]?.['retired']).toBe(true);
			expect(
				(yield* Effect.exit(execute(yield* commands.append(scope, [event('late', 'committed')]))))
					._tag
			).toBe('Failure');
			expect((yield* execute(yield* commands.purge(['p', 't'])))[0]?.['removed']).toBe(2);
			expect((yield* execute(yield* commands.isRetired(['p', 't'])))[0]?.['retired']).toBe(true);
		})
);
