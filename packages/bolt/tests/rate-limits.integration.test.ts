// Rate limits over HTTP (rule 38): a tiny declared limit admits two calls and refuses the third, and each path's
// refusal is pinned exactly as the client receives it (status, body, Retry-After). No model call is made.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, layer } from '@effect/vitest';
import { Effect, Layer, Result, Schema } from 'effect';
import { RateWindows } from '../src/engine/access/rate.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { RATE_LIMITED, uuidv7 } from '../src/protocol/wire.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { SHELL } from '../src/shell/nav.ts';
import { KitInvalid, TestWorkspace } from '../../bolt-cli/src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			notes: { description: 'A note', label: 'title', fields: { title: { kind: 'text' } } }
		},
		relationships: {},
		exposures: {
			notes: { read: { notes: { fields: 'all' } }, create: { columns: { notes: ['title'] } } }
		},
		integrations: {},
		policies: {
			writer: {
				description: 'Writes notes, two a minute',
				grants: { notes: { read: true, create: true } },
				limits: { act: '2/min', read: '2/min' }
			},
			chatter: {
				description: 'Two agent posts a minute',
				grants: { notes: { read: true } },
				limits: { agent: [{ rate: '2/min', per: 'actor' }] }
			},
			reader: {
				description: 'Public reads, two a minute per IP',
				grants: { notes: { read: true } },
				limits: { read: { rate: '2/min', per: 'ip' } }
			}
		},
		teams: {
			Writers: { name: 'Writers', policies: ['writer'] },
			Chatters: { name: 'Chatters', policies: ['chatter'] }
		},
		automations: {},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {
			site: {
				title: 'Site',
				description: 'Public notes',
				icon: 'i',
				audience: { public: ['reader'] },
				pages: { home: { title: 'Home' } }
			}
		},
		kiosks: {},
		customFields: {},
		agent: { internal: 'You help.', skills: {} }
	})
);

const ORIGIN = 'https://acme.example';
const workspace = TestWorkspace.layer({ manifest, host: { publicUrl: ORIGIN } });
type Answer = { status: number; body: unknown; retryAfter: string | null };
const send = (
	path: string,
	init: { method?: string; headers?: Record<string, string>; body?: unknown }
) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		const res = yield* t.handle(
			new Request(`${ORIGIN}${path}`, {
				method: init.method ?? 'POST',
				headers: { 'content-type': 'application/json', ...init.headers },
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
			}),
			{ address: '203.0.113.9' }
		);
		const text = yield* Effect.tryPromise({
			try: () => res.text(),
			catch: (e) => new KitInvalid({ message: String(e) })
		});
		const answer: Answer = {
			status: res.status,
			body: text === '' ? null : JSON.parse(text),
			retryAfter: res.headers.get('retry-after')
		};
		return { answer, cookies: res.headers.getSetCookie().map((c) => c.split(';')[0]!) };
	});
const act = (cookie: string, callable: string, input: unknown) =>
	Effect.gen(function* () {
		const t = yield* TestWorkspace;
		return (yield* send('/__bolt/act', {
			headers: { cookie, 'Idempotency-Key': randomUUID() },
			body: { callable, input, issuedAt: t.clock.now() }
		})).answer;
	});
const statuses = (answers: readonly Answer[]) => answers.map((a) => a.status);

layer(workspace)('rate limits over HTTP (rule 38)', (it) => {
	describe('declared tiny limits', () => {
		it.effect(
			'act 2/min: the third act is a 429 refused outcome with Retry-After; the persisted bucket stops at 2',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const cookie = yield* t.session(t.member(['writer'], { teams: ['Writers'] }).id);
					const answers: Answer[] = [];
					for (const title of ['a', 'b', 'c'])
						answers.push(yield* act(cookie, 'notes.create', [{ title }]));
					expect(statuses(answers)).toEqual([200, 200, 429]);
					expect(answers[2]).toEqual({
						status: 429,
						body: {
							outcome: {
								kind: 'refused',
								code: 'rateLimited',
								message: RATE_LIMITED
							},
							v: expect.any(Number)
						},
						retryAfter: expect.stringMatching(/^[1-9]\d*$/)
					});
					const [rows] = yield* t.db.read([
						{ text: `SELECT rule, n FROM bolt_rate WHERE rule LIKE 'act:%'`, params: [] }
					]);
					expect(rows?.rows).toEqual([{ rule: 'act:2/min:actor', n: 2 }]);
					// another member's bucket is their own
					const other = yield* t.session(t.member(['writer'], { teams: ['Writers'] }).id);
					expect((yield* act(other, 'notes.create', [{ title: 'd' }])).status).toBe(200);
				})
		);

		it.effect('read 2/min for a member: the third /q is a 429 per actor, with Retry-After', () =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const q = (cookie: string) =>
					send('/__bolt/q', {
						headers: { cookie },
						body: { reads: [{ m: 'query', a: [{ notes: {} }] }] }
					}).pipe(Effect.map((r) => r.answer));
				const cookie = yield* t.session(t.member(['writer'], { teams: ['Writers'] }).id);
				const answers = [yield* q(cookie), yield* q(cookie), yield* q(cookie)];
				expect(statuses(answers)).toEqual([200, 200, 429]);
				expect(answers[2]).toEqual({
					status: 429,
					body: { error: { code: 'rateLimited', message: RATE_LIMITED } },
					retryAfter: expect.stringMatching(/^[1-9]\d*$/)
				});
				// a live registration is a read on the same bucket
				expect(
					(yield* send('/__bolt/live', { headers: { cookie }, body: { conn: randomUUID() } }))
						.answer.status
				).toBe(429);
				// another member's bucket is their own
				const other = yield* t.session(t.member(['writer'], { teams: ['Writers'] }).id);
				expect((yield* q(other)).status).toBe(200);
			})
		);

		it.effect(
			'a refusal the statement decides (a persisted bucket already full) also names Retry-After',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const writer = t.member(['writer'], { teams: ['Writers'] });
					const cookie = yield* t.session(writer.id);
					const now = Date.parse(t.clock.now());
					yield* t.db.write({
						text: `INSERT INTO bolt_rate (rule, bucket, window_start, n) VALUES ('act:2/min:actor', $1, $2::timestamptz, 2)`,
						params: [writer.id, new Date(now - (now % 60_000)).toISOString()]
					});
					expect(yield* act(cookie, 'notes.create', [{ title: 'x' }])).toEqual({
						status: 429,
						body: {
							outcome: { kind: 'refused', code: 'rateLimited', message: RATE_LIMITED },
							v: expect.any(Number)
						},
						retryAfter: expect.stringMatching(/^[1-9]\d*$/)
					});
				})
		);

		it.effect(
			'agent 2/min: the third sys_message.post is refused before any model call; refusals count',
			() =>
				Effect.gen(function* () {
					const t = yield* TestWorkspace;
					const cookie = yield* t.session(t.member(['chatter'], { teams: ['Chatters'] }).id);
					// an unknown conversation: the post is charged, then refused notFound; no turn starts
					const post = act(cookie, 'sys_message.post', { conversation: randomUUID(), text: 'hi' });
					const answers = [yield* post, yield* post, yield* post];
					expect(statuses(answers)).toEqual([404, 404, 429]);
					expect(answers[2]).toEqual({
						status: 429,
						body: {
							outcome: {
								kind: 'refused',
								code: 'rateLimited',
								message: RATE_LIMITED
							},
							v: expect.any(Number)
						},
						retryAfter: expect.stringMatching(/^[1-9]\d*$/)
					});
					// filter.describe draws on the same agent bucket
					expect(
						(yield* act(cookie, 'filter.describe', { model: 'notes', text: 'recent' })).status
					).toBe(429);
				})
		);

		it.effect('visitor read 2/min per IP: the third /q is a 429 error body with Retry-After', () =>
			Effect.gen(function* () {
				const boot = yield* send(`${SHELL}?app=site`, { method: 'GET' });
				expect(boot.answer.status).toBe(200);
				const headers = { cookie: boot.cookies.join('; '), 'Bolt-App': 'site' };
				const answers: Answer[] = [];
				for (let i = 0; i < 3; i++)
					answers.push(
						(yield* send('/__bolt/q', {
							headers,
							body: { reads: [{ m: 'query', a: [{ notes: {} }] }] }
						})).answer
					);
				expect(statuses(answers)).toEqual([200, 200, 429]);
				expect(answers[2]).toEqual({
					status: 429,
					body: { error: { code: 'rateLimited', message: RATE_LIMITED } },
					retryAfter: expect.stringMatching(/^\d+$/)
				});
			})
		);

		it.effect('sign-in: the sixth code for one address in an hour is a 429 with Retry-After', () =>
			Effect.gen(function* () {
				const answers: Answer[] = [];
				for (let i = 0; i < 6; i++)
					answers.push(
						(yield* send('/__bolt/session/code', { body: { address: 'flood@acme.example' } }))
							.answer
					);
				expect(statuses(answers)).toEqual([200, 200, 200, 200, 200, 429]);
				expect(answers[5]).toEqual({
					status: 429,
					body: { error: { code: 'rateLimited', message: RATE_LIMITED } },
					retryAfter: expect.stringMatching(/^\d+$/)
				});
			})
		);
	});
});

describe('RateWindows (rule 72)', () => {
	const charge = (bucket: string, windowMs = 60_000) => [
		{ rule: 'read:2/min:actor', bucket, limit: 2, windowMs }
	];
	it('stays bounded: when full, ended windows go first, then the oldest until half remain', () => {
		const w = new RateWindows(4);
		w.charge(charge('a', 1_000), 0);
		w.charge(charge('b', 1_000), 0);
		w.charge(charge('c'), 0);
		w.charge(charge('d'), 0);
		expect(w.size).toBe(4);
		// a and b ended at 1 000: dropped; c and d stay open and keep counting
		w.charge(charge('e'), 1_500);
		expect(w.size).toBe(3);
		w.charge(charge('c'), 1_500);
		expect(w.charge(charge('c'), 1_500)).toEqual({ ok: false, retryAfter: 59 });
		// nothing ended: the oldest go until half remain
		w.charge(charge('f'), 2_000);
		w.charge(charge('g'), 2_000);
		expect(w.size).toBeLessThanOrEqual(4);
		for (let i = 0; i < 1_000; i++) w.charge(charge(`x${i}`), 2_000);
		expect(w.size).toBeLessThanOrEqual(4);
	});
	it('a hit does not reorder: counts persist across hits within the window', () => {
		const w = new RateWindows();
		expect(w.charge(charge('a'), 0)).toEqual({ ok: true });
		expect(w.charge(charge('a'), 10_000)).toEqual({ ok: true });
		expect(w.charge(charge('a'), 20_000)).toEqual({ ok: false, retryAfter: 40 });
		// the next window starts over
		expect(w.charge(charge('a'), 60_000)).toEqual({ ok: true });
	});
	it('load restores persisted open windows', () => {
		const w = new RateWindows();
		w.load([{ rule: 'read:2/min:actor', bucket: 'a', start: 60_000, n: 2 }], 60_000);
		expect(w.charge(charge('a'), 61_000)).toEqual({ ok: false, retryAfter: 59 });
	});
});

// Automations (rule 38): only a manual start counts, against the automation's own `limit` per starter. Cron and
// model effect runs, and the acts any run's body performs, are never limited.
const runs = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			notes: { description: 'A note', label: 'title', fields: { title: { kind: 'text' } } },
			logs: { description: 'A log line', label: 'title', fields: { title: { kind: 'text' } } }
		},
		relationships: {},
		exposures: {
			notes: {
				read: { notes: { fields: 'all' } },
				create: { columns: { notes: ['title'] } },
				effect: { created: true }
			},
			logs: { read: { logs: { fields: 'all' } }, create: { columns: { logs: ['title'] } } }
		},
		integrations: {},
		policies: {
			worker: {
				description: 'Writes notes and logs, starts the manual automation',
				grants: { notes: { read: true, create: true }, logs: { read: true, create: true } },
				automations: ['manual'],
				limits: { act: '1000/min' }
			}
		},
		teams: { Workers: { name: 'Workers', policies: ['worker'] } },
		automations: {
			manual: { description: 'Logs three lines', policies: ['worker'], limit: '2/min' },
			tick: {
				description: 'Logs three lines',
				on: { cron: '* * * * *' },
				policies: ['worker'],
				limit: '1/h'
			}
		},
		connections: {},
		envoys: {},
		mcp: {},
		apps: {},
		kiosks: {},
		customFields: {},
		agent: { internal: 'You help.', skills: {} }
	})
);
const lines = (tag: string) =>
	`function* (_, ctx) { for (const i of [1, 2, 3]) yield* ctx.act('logs.create', [{ title: '${tag}' + i }]); }`;
const automations = Effect.gen(function* () {
	return TestWorkspace.layer({
		manifest: runs,
		guest: yield* program(
			`export default { model: { notes: { bodies: { effect: { created: ${lines('r')} } } } }, automation: { manual: { body: ${lines('m')} }, tick: { body: ${lines('t')} } } };`
		),
		host: { publicUrl: ORIGIN },
		now: '2026-10-29T08:00:30.000Z'
	});
});

layer(Layer.unwrap(automations))('automation limits (rule 38)', (it) => {
	it.effect(
		'a manual start beyond its limit is a 429 with Retry-After; cron and effect runs and run bodies are unaffected',
		() =>
			Effect.gen(function* () {
				const t = yield* TestWorkspace;
				const cookie = yield* t.session(t.member(['worker'], { teams: ['Workers'] }).id);
				const start = () =>
					act(cookie, 'start', {
						automation: 'manual',
						id: uuidv7(Date.parse(t.clock.now())),
						input: {}
					});
				const answers = [yield* start(), yield* start(), yield* start()];
				expect(
					statuses(answers)
						.slice(0, 2)
						.every((s) => s < 400)
				).toBe(true);
				expect(answers[2]).toEqual({
					status: 429,
					body: {
						outcome: { kind: 'refused', code: 'rateLimited', message: RATE_LIMITED },
						v: expect.any(Number)
					},
					retryAfter: '30'
				});
				// two notes run the created effect; the cron fires `tick` (`limit: 1/h`, never applied to it) each minute
				expect((yield* act(cookie, 'notes.create', [{ title: 'a' }, { title: 'b' }])).status).toBe(
					200
				);
				yield* t.runDue();
				t.clock.advance('1min');
				yield* t.runDue();
				t.clock.advance('1min');
				yield* t.runDue();
				const count = (prefix: string) =>
					t.db.value(Schema.Number, {
						text: `SELECT count(*)::int FROM logs WHERE title LIKE $1`,
						params: [`${prefix}%`]
					});
				// every body act committed: two manual runs, at least two cron ticks, the effect run
				expect(yield* count('m')).toBe(6);
				expect(yield* count('t')).toBeGreaterThanOrEqual(6);
				expect(yield* count('r')).toBeGreaterThanOrEqual(3);
			})
	);
});
