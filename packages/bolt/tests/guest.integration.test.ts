/// <reference types="node" />
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { type Bridge, type Invocation, LIMITS, type Sql, type TenantDb } from '../src/engine/contracts.ts';
import { guestRunner } from '../src/engine/guest/runner.ts';
import { EventLog, eventsPiece, SLICE } from '../src/engine/guest/telemetry.ts';
import { RANK, schemaObjects } from '../src/engine/schema/ddl.ts';
import { SYSTEM } from '../src/system/index.ts';

let pg: PGlite;
let statements = 0;
const db: Pick<TenantDb, 'write'> = {
	write: async (s: Sql) => {
		statements += 1;
		const r = await pg.query<{ [column: string]: Json }>(s.text, [...s.params]);
		return { rows: r.rows, affected: r.affectedRows ?? 0 };
	},
};
const rows = async () => (await pg.query<{ n: number }>('select count(*)::int as n from sys_event')).rows[0]?.n;

beforeAll(async () => {
	pg = new PGlite();
	// the log's table as the schema plan renders the built-in layer's `sys_event`
	const log = schemaObjects({ models: { sys_event: SYSTEM.models['sys_event']! }, relationships: {}, currency: null, tz: 'UTC' })
		.filter((o) => o.table === 'sys_event').sort((a, b) => RANK[a.rank] - RANK[b.rank]);
	for (const text of log.flatMap((o) => o.create)) await pg.exec(text);
});
afterAll(() => pg.close());
beforeEach(async () => {
	await pg.exec('truncate sys_event');
	statements = 0;
});

const invocation: Invocation = {
	id: 'run-1', kind: 'automation', target: 'a', input: null,
	ctx: { actor: { kind: 'system', run: 'run-1', by: { automation: 'a' } }, now: '2026-01-01T00:00:00.000Z', today: '2026-01-01', tz: 'UTC', seed: 's' },
	budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.automation, readBytes: LIMITS.readBytes },
};
const threeCalls = 'export default { automation: { a: { body: async (_, ctx) => { for (let i = 0; i < 3; i++) await ctx.ai.sys_2.infer({ prompt: "p" + i }); return "done"; } } } };';
const run = (events: EventLog, bridge: Bridge) =>
	guestRunner({ source: threeCalls }, { lowerRead: () => { throw new Error('no reads'); }, events, console: () => {} }).invoke(invocation, bridge);

describe('next guest telemetry (§5.12)', () => {
	it('keeps a slice of a long invocation\'s records before it ends, as one statement between crossings', async () => {
		const events = new EventLog({ invocation: 'run-1', run: 'run-1' }, db, () => {});
		const seen: (number | undefined)[] = [];
		let call = 0;
		const bridge: Bridge = {
			cross: async (calls) => {
				seen.push(await rows());
				if (call++ === 0) for (let i = 0; i < SLICE.events + 50; i++) events.emit('info', 'model.call', { step: i });
				return calls.map(() => ({ ok: true, value: 'answer' }));
			},
		};
		expect(await run(events, bridge)).toMatchObject({ kind: 'ok', output: 'done' });
		expect(seen).toEqual([0, 250, 250]);
		expect(statements).toBe(1);
		events.emit('info', 'run.settled');
		await events.end();
		expect([await rows(), statements]).toEqual([251, 2]);
	});

	it('slices after 10 s even under 200 events', async () => {
		let now = Date.parse('2026-01-01T00:00:00Z');
		const events = new EventLog({ invocation: 'run-1' }, db, () => {}, () => now);
		const bridge: Bridge = {
			cross: async (calls) => {
				events.emit('info', 'model.call');
				now += SLICE.ms / 2 + 1;
				return calls.map(() => ({ ok: true, value: 'answer' }));
			},
		};
		await run(events, bridge);
		expect([await rows(), statements]).toEqual([2, 1]);
	});

	it('hands its buffer to an act statement as one piece, leaving nothing to write after', async () => {
		const lines: string[] = [];
		const events = new EventLog({ invocation: 'act-1' }, db, (l) => lines.push(l));
		events.emit('warn', 'act.refused', { message: 'no leave left' });
		events.emit('info', 'write', { statements: 1, pieces: 3 });
		const taken = events.take();
		const r = await db.write({ text: `with e as (${eventsPiece(1)} returning 1) select count(*)::int as n from e`, params: [JSON.stringify(taken)] });
		await events.end();
		expect([r.rows[0]?.n, statements, lines.length]).toEqual([2, 1, 2]);
		expect((await pg.query<{ severity: string; attributes: Json }>('select severity, attributes from sys_event order by id')).rows)
			.toEqual([{ severity: 'warn', attributes: { message: 'no leave left' } }, { severity: 'info', attributes: { statements: 1, pieces: 3 } }]);
	});
});
