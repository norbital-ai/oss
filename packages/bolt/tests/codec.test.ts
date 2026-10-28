// The value codec without a database: wire tags become std's values in the guest (§3.3.10, §5.8).
import { describe, expect, it } from '@effect/vitest';
import type { Json } from '../src/decl/values.ts';
import { Effect } from 'effect';
import { type Invocation, LIMITS } from '../src/engine/contracts.ts';
import { Guest, type Bridge } from '../src/engine/services.ts';
import { program } from '../src/test/guest.ts';
import { guestLayer } from './support/guest-fixture.ts';
import { createBolt } from '../src/page/bolt.ts';
import { Decimal } from '@norbital-ai/std/decimal';

const invocation = (input: Json): Invocation => ({
	id: 'inv-1',
	kind: 'automation',
	target: 'a',
	input,
	ctx: {
		actor: { kind: 'system', run: 'r1', by: { platform: 'test' } },
		now: '2026-01-01T20:00:00.000Z',
		today: '2026-01-01',
		tz: 'UTC',
		seed: 's'
	},
	budget: {
		crossings: LIMITS.crossings.sync,
		readBytes: LIMITS.readBytes
	}
});

describe('codec: guest reads hand real values, not wire tags', () => {
	it.live(
		"dates and instants arrive as ISO strings, decimals as the bundle's std Decimal, in answers and in the input",
		() =>
			Effect.gen(function* () {
				// the bundle's std/decimal registers its class on load, as `@norbital-ai/std/next/decimal` does
				const source = `class Decimal { static of(s) { const d = new Decimal(); d.text = s; return d; } toJSON() { return this.text; } }
globalThis[Symbol.for('norbital.std.Decimal')] = Decimal;
export default { automation: { a: { body: function* (input, ctx) {
	const row = (yield* ctx.query({ t: { where: { id: { eq: 'x' } } } })).t.rows[0];
	return { amount: row.amount instanceof Decimal, text: String(row.amount.text), day: row.day, at: row.at, span: row.span, json: row.json, input: input.due };
} } } };`;
				const row = {
					amount: { $dec: '1.50' },
					day: '2026-01-02',
					at: '2026-01-02T03:04:05.000Z',
					span: { from: '2026-01-01', to: null },
					json: { $d: 'x', other: 1 }
				};
				const bridge: Bridge = {
					cross: (calls) =>
						Effect.succeed(calls.map(() => ({ ok: true, value: { t: { rows: [row], next: null } } })))
				};
				const guest = yield* program(source);
				const o = yield* Guest.pipe(
					Effect.flatMap((service) => service.invoke(invocation({ due: '2026-03-01' }), bridge)),
					Effect.provide(
						guestLayer(guest, {
							lowerRead: () => ({
								kind: 'request',
								roots: [
									{
										root: 't',
										read: {
											kind: 'get',
											model: 't',
											id: 'x',
											select: { fields: null, relations: {} }
										}
									}
								]
							}),
							console: () => {}
						})
					)
				);
				expect(o).toMatchObject({
					kind: 'ok',
					output: {
						amount: true,
						text: '1.50',
						day: '2026-01-02',
						at: '2026-01-02T03:04:05.000Z',
						span: { from: '2026-01-01', to: null },
						json: { $d: 'x', other: 1 },
						input: '2026-03-01'
					}
				});
			})
	);
});

describe('codec: $bolt reads hand pages real values', () => {
	it.live('a `/q` answer decodes dates, instants and decimals at any depth', () =>
		Effect.gen(function* () {
			const answer = {
				rows: [
					{
						id: 'a',
						amount: { $dec: '1.50' },
						day: '2026-01-02',
						span: { start: '2026-01-02T03:04:05.000Z', end: null },
						lines: [{ price: { $dec: '2' } }]
					}
				],
				next: null
			};
			const fetch: typeof globalThis.fetch = async () => Response.json({ answers: [{ t: answer }] });
			const bolt = yield* createBolt({
				base: 'https://workspace.test',
				actor: null,
				locale: 'en',
				fetch,
				openStream: () => ({ onmessage: null, onerror: null, close() {} })
			});
			const { t: page } = yield* bolt.query<{
				t: { rows: {
					amount: Decimal;
					day: string;
					span: { start: string };
					lines: { price: Decimal }[];
				}[] };
			}>({ t: { limit: 1 } });
			const row = page.rows[0];
			if (row === undefined) throw new Error('The fixture page returned no row');
			expect(row.amount).toBeInstanceOf(Decimal);
			expect(row.amount.plus('1').toString()).toBe('2.50');
			expect(row.lines[0]?.price).toBeInstanceOf(Decimal);
			expect([row.day, row.span.start]).toEqual(['2026-01-02', '2026-01-02T03:04:05.000Z']);
		})
	);
});
