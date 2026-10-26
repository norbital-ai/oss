import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import {
	AuditEvent,
	AuditPage,
	AuditPendingPage,
	AuditPendingQuery,
	AuditQuery,
	AuditRecord,
	AuditSummary
} from '../src/protocol/audit.ts';
import { shellApi } from '../src/shell/runtime.ts';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { auditShape } from '../src/engine/audit.ts';
import { FacilityFailure } from '../src/decl/errors.ts';
import { memoryAudit } from '../src/test/audit.ts';

const event: AuditEvent = {
	id: 'act-1/accounts/account-1/2/committed',
	operationId: 'act-1',
	at: '2026-10-25T00:00:00.000Z',
	category: 'write',
	action: 'accounts.update',
	status: 'committed',
	actor: { kind: 'member', id: 'member-1', label: 'Avery' },
	subject: { model: 'accounts', id: 'account-1', revision: 2 },
	invocation: 'act-1',
	transaction: null,
	run: null,
	approval: null,
	payload: { before: { balance: '20.00' }, after: { balance: '15.00' } }
};
const stored = {
	recordedAt: '2026-10-25T00:00:01.000Z',
	payloadBytes: new TextEncoder().encode(JSON.stringify(event.payload)).byteLength
};
const record: AuditRecord = { ...event, ...stored };

it.effect('audit caller failures remain invalid while store outages remain unavailable', () =>
	Effect.gen(function* () {
		const store = memoryAudit();
		const buffered = yield* auditShape({ ...store.port, mode: 'buffered' });
		expect(buffered.mode).toBe('buffered');
		yield* buffered.append([event]);
		expect((yield* buffered.detail(event.id))?.payload).toEqual(event.payload);
		const invalid = yield* auditShape({
			...store.port,
			query: async () => {
				throw new FacilityFailure({ kind: 'invalid', message: 'Cursor belongs to another query.' });
			}
		});
		expect(yield* Effect.flip(invalid.query({ after: 'cursor' }))).toMatchObject({
			code: 'invalid',
			message: 'Cursor belongs to another query.'
		});
		const offline = yield* auditShape({
			...store.port,
			query: async () => {
				throw new Error('database offline');
			}
		});
		expect(yield* Effect.flip(offline.query({}))).toMatchObject({ code: 'unavailable' });
	}).pipe(Effect.provide(NodeCrypto.layer))
);

it('audit list and detail contracts distinguish metadata from the complete payload', () => {
	const summary = Schema.decodeUnknownSync(AuditSummary)(record);
	expect(summary.actor).toEqual(event.actor);
	expect(summary.subject).toEqual(event.subject);
	expect(Object.hasOwn(summary, 'payload')).toBe(false);
	expect(Schema.decodeUnknownSync(AuditRecord)(record).payload).toEqual(event.payload);
	expect(Schema.decodeUnknownSync(AuditPage)({ rows: [summary], next: 'opaque-next' })).toEqual({
		rows: [summary],
		next: 'opaque-next'
	});
});

it('audit filters validate bounded pages and native actor, event and lifecycle choices', () => {
	for (const limit of [0, 201, 1.5, Infinity]) {
		expect(() => Schema.decodeUnknownSync(AuditQuery)({ limit })).toThrow();
	}
	for (const query of [
		{ actorKind: 'administrator' },
		{ category: 'source-code-audit' },
		{ status: 'assumedCommitted' },
		{ order: 'payload' }
	]) {
		expect(() => Schema.decodeUnknownSync(AuditQuery)(query)).toThrow();
	}
	expect(
		Schema.decodeUnknownSync(AuditQuery)({
			actorKind: 'member',
			actorId: 'member-1',
			category: 'write',
			status: 'unknown',
			order: 'oldest',
			limit: 200
		})
	).toEqual({
		actorKind: 'member',
		actorId: 'member-1',
		category: 'write',
		status: 'unknown',
		order: 'oldest',
		limit: 200
	});
});

it('reconciliation pages carry only prepared payloads and share the bounded cursor contract', () => {
	const prepared = { ...record, id: 'act-1:prepared', status: 'prepared' };
	expect(Schema.decodeUnknownSync(AuditPendingPage)({ rows: [prepared], next: 'next' })).toEqual({
		rows: [prepared],
		next: 'next'
	});
	expect(() =>
		Schema.decodeUnknownSync(AuditPendingPage)({ rows: [record], next: null })
	).toThrow();
	expect(() => Schema.decodeUnknownSync(AuditPendingQuery)({ limit: 201 })).toThrow();
});

it.effect('the shell forwards server filters and fetches a full payload only for detail', () =>
	Effect.gen(function* () {
		const queries: AuditQuery[] = [];
		const details: string[] = [];
		const summary = Schema.decodeUnknownSync(AuditSummary)(record);
		const api = shellApi(
			async (input, init) => {
				const url = new URL(String(input), 'https://workspace.example');
				if (url.pathname.endsWith('/audit/query')) {
					expect(init?.method).toBe('POST');
					if (init?.body == null) throw new Error('audit query requires a JSON body');
					const body = await new Response(init.body).text();
					queries.push(Schema.decodeUnknownSync(Schema.fromJsonString(AuditQuery))(body));
					return Response.json({ value: { rows: [summary], next: null } });
				}
				if (url.pathname.endsWith('/audit/detail')) {
					const id = url.searchParams.get('id');
					if (id === null) throw new Error('audit detail requires an event id');
					details.push(id);
					return Response.json({ value: record });
				}
				throw new Error(`unexpected audit request ${url.pathname}`);
			},
			{ base: 'https://workspace.example' }
		);
		const query: AuditQuery = {
			text: 'balance',
			model: 'accounts',
			actorId: 'member-1',
			status: 'committed',
			since: '2026-10-24T00:00:00Z',
			until: '2026-10-26T00:00:00Z',
			order: 'newest',
			limit: 2
		};
		const page = yield* api.audit(query);
		expect(queries).toEqual([query]);
		expect(details).toEqual([]);
		expect(page.rows).toEqual([summary]);
		expect(Object.hasOwn(page.rows[0] ?? {}, 'payload')).toBe(false);
		expect((yield* api.auditDetail(event.id))?.payload).toEqual(event.payload);
		expect(details).toEqual([event.id]);
	})
);

it.effect('audit unavailability and malformed pages remain errors, not empty history', () =>
	Effect.gen(function* () {
		const unavailable = shellApi(
			async () =>
				Response.json(
					{ error: { code: 'unavailable', message: 'Audit store is not configured.' } },
					{ status: 503 }
				),
			{ base: 'https://workspace.example' }
		);
		expect((yield* Effect.flip(unavailable.audit({}))).code).toBe('unavailable');
		const malformed = shellApi(async () => Response.json({ value: [] }), {
			base: 'https://workspace.example'
		});
		expect((yield* Effect.flip(malformed.audit({}))).code).toBe('protocol');
		const absent = shellApi(async () => Response.json({ value: null }), {
			base: 'https://workspace.example'
		});
		expect(yield* absent.auditDetail('missing')).toBeNull();
	})
);
