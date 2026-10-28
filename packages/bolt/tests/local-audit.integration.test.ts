// The local development audit store over PGlite: appends are idempotent and refuse a changed event (BA102), and pages
// and recovery reads continue by cursor across a reopen. Native immutability and retention are Store's (log.test).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { localAudit } from '../src/node/audit.ts';
import type { AuditEvent } from '../src/protocol/audit.ts';

const scratch = (prefix: string) =>
	Effect.acquireRelease(
		Effect.sync(() => mkdtempSync(join(tmpdir(), prefix))),
		(root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
	);
const auditEvent = (id: string, status: AuditEvent['status'] = 'prepared'): AuditEvent => ({
	id,
	operationId: id.split(':')[0] ?? id,
	at: '2001-01-01T00:00:00.000Z',
	category: 'write',
	action: 'ledger.update',
	status,
	actor: { kind: 'member', id: 'admin', label: 'Administrator' },
	subject: { model: 'ledger', id: 'balance', revision: 1 },
	invocation: 'call',
	transaction: null,
	run: 'run',
	approval: null,
	payload: { balance: 20, evidence: `needle%_\\${'x'.repeat(4000)}` }
});

it.live('local development audit survives reopen with complete payloads and bounded recovery', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const root = yield* scratch('dev-durable-audit-'),
				directory = join(root, 'audit');
			const events = [
				auditEvent('complete:prepared'),
				auditEvent('complete:terminal', 'committed'),
				auditEvent('waiting-a:prepared'),
				auditEvent('waiting-a:terminal', 'unknown'),
				auditEvent('waiting-b:prepared')
			];
			const first = yield* Effect.scoped(
				Effect.gen(function* () {
					const port = yield* localAudit(directory);
					expect(existsSync(directory)).toBe(false);
					yield* Effect.tryPromise((signal) => port.append(events, signal));
					yield* Effect.tryPromise((signal) => port.append(events, signal));
					const candidate = auditEvent('rolled-back:prepared');
					yield* Effect.tryPromise(async (signal) => {
						await expect(
							port.append(
								[candidate, { ...auditEvent('complete:prepared'), payload: { changed: true } }],
								signal
							)
						).rejects.toMatchObject({ code: 'BA102' });
						expect(await port.detail(candidate.id, signal)).toBeNull();
					});
					const page = yield* Effect.tryPromise((signal) =>
						port.query({ order: 'oldest', limit: 1 }, signal)
					);
					expect(page.rows.map((row) => row.id)).toEqual(['complete:prepared']);
					expect(page.rows[0]).not.toHaveProperty('payload');
					if (page.next === null) return yield* Effect.die('Audit pagination has no continuation.');
					return { port, cursor: page.next };
				})
			);
			yield* Effect.tryPromise(async (signal) => {
				await expect(first.port.detail('complete:prepared', signal)).rejects.toThrow('closed');
			});
			yield* Effect.scoped(
				Effect.gen(function* () {
					const port = yield* localAudit(directory);
					const detail = yield* Effect.tryPromise((signal) =>
						port.detail('waiting-a:prepared', signal)
					);
					expect(detail).toMatchObject(auditEvent('waiting-a:prepared'));
					expect(detail?.payloadBytes).toBeGreaterThan(4000);
					const next = yield* Effect.tryPromise((signal) =>
						port.query({ order: 'oldest', limit: 1, after: first.cursor }, signal)
					);
					expect(next.rows.map((row) => row.id)).toEqual(['complete:terminal']);
					const filtered = yield* Effect.tryPromise((signal) =>
						port.query(
							{
								text: 'needle%_\\',
								actorKind: 'member',
								actorId: 'admin',
								category: 'write',
								action: 'ledger.update',
								status: 'prepared',
								model: 'ledger',
								record: 'balance',
								invocation: 'call',
								run: 'run',
								since: '2001-01-01T00:00:00.000Z',
								until: '2002-01-01T00:00:00.000Z',
								order: 'oldest'
							},
							signal
						)
					);
					expect(filtered.rows.map((row) => row.id)).toEqual([
						'complete:prepared',
						'waiting-a:prepared',
						'waiting-b:prepared'
					]);
					const pending = yield* Effect.tryPromise((signal) => port.pending({ limit: 1 }, signal));
					expect(pending.rows.map((row) => row.id)).toEqual(['waiting-a:prepared']);
					expect(pending.rows[0]?.payload).toEqual(auditEvent('waiting-a:prepared').payload);
					if (pending.next === null)
						return yield* Effect.die('Audit recovery pagination has no continuation.');
					const pendingCursor = pending.next;
					const pendingNext = yield* Effect.tryPromise((signal) =>
						port.pending({ limit: 1, after: pendingCursor }, signal)
					);
					expect(pendingNext.rows.map((row) => row.id)).toEqual(['waiting-b:prepared']);
					expect(pendingNext.next).toBeNull();
					yield* Effect.tryPromise(async (signal) => {
						await expect(
							port.query({ status: 'failed', order: 'oldest', after: first.cursor }, signal)
						).rejects.toThrow('another query');
						await expect(port.pending({ after: first.cursor }, signal)).rejects.toThrow(
							'another query'
						);
					});
				})
			);
		})
	)
);
