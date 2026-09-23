import { createHmac } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmailEnvelope } from '@norbital-ai/bolt-protocol';
import { channel, defineChannel, defineEnvironment, defineIntegration, http } from '../src/authoring/index.js';
import { describeChannel } from '../src/authoring/channels-schema.js';
import { describeIntegration } from '../src/authoring/integrations-schema.js';
import { field } from '../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Channels from '../src/runtime/channels/channels.js';
import * as Collections from '../src/runtime/collections/collections.js';
import * as Integrations from '../src/runtime/integrations/integrations.js';
import { Secrets } from '../src/runtime/secrets/secrets.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordingCommunication,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * The serial-pcn mail flow on channels (channels.md §9, integrations.md §9.4): a sent notice is an
 * outbound rule, its delivery and reply are events patching the notice, and supplier mail arriving
 * at the same address becomes `pcn_notices` rows through a one-way sync sourced from the channel.
 */

const pcnMail = describeChannel(
	'pcn_mail',
	defineChannel({
		transport: 'email',
		address: 'pcn',
		policies: ['admin'],
		outbound: {
			notices: {
				from: 'sent_emails',
				on: 'create',
				message: ({ record }: { readonly record: Readonly<Record<string, unknown>> }) => ({
					to: [String(record['to_address'])],
					subject: String(record['subject']),
					html: String(record['body_html']),
					thread: String(record['id'])
				})
			}
		},
		events: {
			delivered: () => ({ status: 'delivered' }),
			bounced: ({ reason }: { readonly reason: string }) => ({ status: 'bounced', failure_reason: reason }),
			opened: ({ at }: { readonly at: string }) => ({ opened_at: at }),
			replied: ({ mail }: { readonly mail: EmailEnvelope }) => ({
				replied_at: mail.sentAt,
				reply_excerpt: mail.text.slice(0, 500)
			})
		}
	} as never)
);

const notices = describeIntegration(
	'supplier_mail',
	defineIntegration({
		policies: ['admin'],
		syncs: {
			pcn_notices: {
				direction: 'one_way',
				source: channel('pcn_mail').messages({ inbound: true }),
				identity: 'message_id',
				fields: {
					from_address: 'from.address',
					subject: 'subject',
					raw_body: 'text',
					received_at: 'sentAt'
				}
			}
		}
	} as never)
);

const collections = [
	{
		name: 'sent_emails',
		fields: {
			to_address: field.string(),
			subject: field.string(),
			body_html: field.string(),
			status: field.string(),
			failure_reason: field.string(),
			opened_at: field.string(),
			replied_at: field.string(),
			reply_excerpt: field.string()
		}
	},
	{
		name: 'pcn_notices',
		fields: {
			message_id: field.string(),
			from_address: field.string(),
			subject: field.string(),
			raw_body: field.string(),
			received_at: field.string(),
			triage: field.string()
		}
	}
];
const everyColumn = (names: ReadonlyArray<string>) =>
	Object.fromEntries(names.map((name) => [name, true as const]));

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const mail = (overrides: Partial<EmailEnvelope>): EmailEnvelope => ({
	_tag: 'email',
	messageId: '<m1@supplier.test>',
	threadId: '<m1@supplier.test>',
	from: { address: 'pcn@supplier.test', name: 'Supplier' },
	to: [{ address: 'pcn.acme@in.norbital.ai' }],
	cc: [],
	subject: 'PCN-2026-017: MC74HC00 end of life',
	text: 'The MC74HC00 is discontinued; last time buy 2026-12-31.',
	attachments: [],
	sentAt: '2026-09-23T08:00:00.000Z',
	headers: {},
	...overrides
});

describe('the PCN mail flow on channels', () => {
	it('sends a notice, records delivery and reply on it, and turns supplier mail into rows', async () => {
		const transport = recordingCommunication();
		const definition = {
			...testWorkspace({ collections }),
			channels: [pcnMail.declaration],
			integrations: [notices.declaration]
		};
		harness = await makeBoltTestRuntime(definition, {
			communication: transport.binding,
			authored: {
				...emptyAuthoredRuntime,
				collections: {
					sent_emails: {
						create: { input: { columns: everyColumn(Object.keys(collections[0]!.fields)) } },
						update: { input: { columns: everyColumn(Object.keys(collections[0]!.fields)) } },
						delete: {}
					},
					pcn_notices: {
						create: { input: { columns: everyColumn(Object.keys(collections[1]!.fields)) } },
						update: { input: { columns: everyColumn(Object.keys(collections[1]!.fields)) } },
						delete: {}
					}
				},
				channels: { pcn_mail: pcnMail.authored },
				integrations: { supplier_mail: notices.authored }
			}
		});
		const { runtime, effectId, database } = harness;
		const write = (label: string, collection: string, action: 'create' | 'update', input: Record<string, unknown>) =>
			runtime.runPromise(
				Effect.flatMap(Collections.Service, (service) =>
					service.write(effectId(label), adminSubject, [{ collection, action, inputs: [input] }])
				)
			);
		const channels = await runtime.runPromise(Channels.Service);
		const integrations = await runtime.runPromise(Integrations.Service);
		/** What `channels.ingest` does: history, then every sync sourced from the channel. */
		const receive = async (label: string, envelope: EmailEnvelope) => {
			const rows = await runtime.runPromise(
				channels.ingest(effectId(label), 'pcn_mail', [{ _tag: 'Upsert', envelope, version: envelope.sentAt, origin: 'live', direction: 'inbound' }], {})
			);
			await runtime.runPromise(
				integrations.applyChannel(
					effectId(`${label}:syncs`),
					'pcn_mail',
					rows.map(({ envelope: stored, providerMessageId, version, deleted }) => ({
						record: { ...stored, direction: 'inbound' },
						identity: providerMessageId,
						version,
						deleted
					}))
				)
			);
		};

		// 1. A notice written is a message queued in the same transaction; the drain sends it.
		await write('notice', 'sent_emails', 'create', {
			to_address: 'buyer@customer.test',
			subject: 'Discontinuation notice',
			body_html: '<p>MC74HC00 is discontinued.</p>',
			status: 'queued'
		});
		const [outbox] = await database.query(`select status, source_collection from bolt_channel_outbox`);
		expect(outbox).toEqual({ status: 'pending', source_collection: 'sent_emails' });
		await runtime.runPromise(channels.drain(effectId('drain'), 'pcn_mail'));
		expect(transport.sends).toEqual([
			expect.objectContaining({
				channel: 'pcn_mail',
				transport: 'email',
				message: expect.objectContaining({ to: ['buyer@customer.test'], subject: 'Discontinuation notice' })
			})
		]);
		const [sent] = await database.query(`select status, provider_message_id from bolt_channel_outbox`);
		expect(sent).toEqual({ status: 'sent', provider_message_id: 'wire-1' });

		// 2. The provider reports back: each event patches the notice, and only the notice.
		await runtime.runPromise(
			channels.event(effectId('delivered'), 'pcn_mail', [
				{ providerMessageId: 'wire-1', kind: 'delivered', observedAt: '2026-09-23T08:01:00.000Z', detail: {} }
			])
		);
		await runtime.runPromise(
			channels.event(effectId('opened'), 'pcn_mail', [
				{ providerMessageId: 'wire-1', kind: 'opened', observedAt: '2026-09-23T08:05:00.000Z', detail: {} }
			])
		);
		// 3. The customer replies in-thread: a `replied` event derived from history.
		await receive(
			'reply',
			mail({
				messageId: '<reply@customer.test>',
				threadId: 'wire-1',
				inReplyTo: 'wire-1',
				from: { address: 'buyer@customer.test' },
				subject: 'Re: Discontinuation notice',
				text: 'Thanks — we will last-time-buy 5,000 units.',
				sentAt: '2026-09-23T09:00:00.000Z'
			})
		);
		expect(
			await database.query(`select status, opened_at, replied_at, reply_excerpt from sent_emails`)
		).toEqual([
			{
				status: 'delivered',
				opened_at: '2026-09-23T08:05:00.000Z',
				replied_at: '2026-09-23T09:00:00.000Z',
				reply_excerpt: 'Thanks — we will last-time-buy 5,000 units.'
			}
		]);

		// 4. Supplier mail at the same address is history, and the sync turns it into a notice row.
		await receive('supplier', mail({}));
		// A redelivery is the same history row: nothing twice.
		await receive('supplier-again', mail({}));
		const rows = await database.query(
			`select message_id, from_address, subject, received_at from pcn_notices order by message_id`
		);
		expect(rows).toContainEqual({
			message_id: '<m1@supplier.test>',
			from_address: 'pcn@supplier.test',
			subject: 'PCN-2026-017: MC74HC00 end of life',
			received_at: '2026-09-23T08:00:00.000Z'
		});
		expect(rows.filter((row) => row['message_id'] === '<m1@supplier.test>')).toHaveLength(1);

		// 5. The notices are a mirror: a person may triage one, never invent or rewrite it.
		const [notice] = await database.query(`select id from pcn_notices where message_id = '<m1@supplier.test>'`);
		await write('triage', 'pcn_notices', 'update', { id: notice!['id'], triage: 'actioned' });
		await expect(write('forge', 'pcn_notices', 'create', { message_id: 'x', subject: 'forged' })).rejects.toMatchObject({
			message: expect.stringMatching(/owned by supplier_mail/)
		});

		// 6. The sender recalls it: the tombstone reaches the mirror as a delete.
		const tombstoned = await runtime.runPromise(
			channels.ingest(effectId('recall'), 'pcn_mail', [{ _tag: 'Tombstone', messageId: '<m1@supplier.test>' }], {})
		);
		await runtime.runPromise(
			integrations.applyChannel(
				effectId('recall:syncs'),
				'pcn_mail',
				tombstoned.map(({ envelope, providerMessageId, version, deleted }) => ({
					record: { ...envelope, direction: 'inbound' },
					identity: providerMessageId,
					version,
					deleted
				}))
			)
		);
		expect(await database.query(`select message_id from pcn_notices where message_id = '<m1@supplier.test>'`)).toEqual([]);
	}, 60_000);
});

describe('a sync pushed by a signed webhook', () => {
	it('verifies the delivery before reading it and applies its records idempotently', async () => {
		const Job = Schema.Struct({ reference: Schema.String, title: Schema.String });
		const dispatch = http.source({ baseUrl: 'https://dispatch.test' });
		const described = describeIntegration(
			'dispatch',
			defineIntegration({
				policies: ['admin'],
				syncs: {
					jobs: {
						direction: 'one_way',
						source: dispatch.records({
							list: { path: '/jobs', records: 'jobs' },
							subscribe: {
								webhook: {
									signature: { header: 'x-dispatch-signature', secret: { env: 'DISPATCH_SECRET' }, algorithm: 'sha256', encoding: 'hex' },
									records: 'job'
								}
							},
							identity: 'reference',
							record: Job
						}),
						identity: 'external_ref',
						fields: { title: 'title' }
					}
				}
			} as never)
		);
		const definition = {
			...testWorkspace({ collections: [{ name: 'jobs', fields: { external_ref: field.string(), title: field.string() } }] }),
			integrations: [described.declaration],
			environment: defineEnvironment({ DISPATCH_SECRET: { label: 'Dispatch webhook secret' } })
		};
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				collections: { jobs: { create: { input: { columns: { external_ref: true, title: true } } }, update: { input: { columns: { external_ref: true, title: true } } }, delete: {} } },
				integrations: { dispatch: described.authored }
			}
		});
		const { runtime, effectId, database } = harness;
		await runtime.runPromise(
			Effect.flatMap(Secrets.Service, (secrets) => secrets.write(effectId('secret'), 'DISPATCH_SECRET', 'shh', 'admin-1'))
		);
		const integrations = await runtime.runPromise(Integrations.Service);
		const body = JSON.stringify({ job: { reference: 'JOB-7', title: 'Replace pump seal' } });
		const signature = createHmac('sha256', 'shh').update(body).digest('hex');
		const deliver = (label: string, headers: Record<string, string>) =>
			runtime.runPromise(integrations.receive(effectId(label), 'dispatch', 'jobs', { headers, body }));

		await expect(deliver('forged', { 'x-dispatch-signature': 'deadbeef' })).rejects.toMatchObject({
			message: expect.stringMatching(/delivery refused/)
		});
		expect(await database.query(`select count(*)::int as count from jobs`)).toEqual([{ count: 0 }]);
		await deliver('signed', { 'x-dispatch-signature': signature });
		await deliver('redelivered', { 'x-dispatch-signature': signature });
		expect(await database.query(`select external_ref, title from jobs`)).toEqual([
			{ external_ref: 'JOB-7', title: 'Replace pump seal' }
		]);
	});
});
