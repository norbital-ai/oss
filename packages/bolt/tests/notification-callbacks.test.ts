import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from '@effect/vitest';
import * as NodeChildProcessSpawner from '@effect/platform-node/NodeChildProcessSpawner';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { Context, Effect, Layer } from 'effect';
import { check } from '../src/compiler/check/index.ts';
import { Guest } from '../src/engine/services.ts';
import { notificationRecipients } from '../src/engine/notifications/recipients.ts';
import { guestLayer } from './support/guest-fixture.ts';
import { manifest, NOW, TODAY, admin } from './write-fixture.ts';
const input = {
	event: 'committed' as const,
	action: 'create',
	collection: 'orders',
	records: [{ id: 'order', values: { title: 'Desk' } }],
	requestor: 'member',
	approvers: []
};
const invocation = {
	id: 'notice',
	target: 'orders.committed.0',
	ctx: { actor: admin.actor, now: NOW, today: TODAY, tz: 'UTC', seed: 'notice' }
};
describe('notification callback compilation', () => {
	it.live(
		'serializes the callback marker and executes the original authored body in a fresh isolate',
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync(join(tmpdir(), 'bolt-notification-'))),
					(dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))
				);
				mkdirSync(join(root, 'src/data/model'), { recursive: true });
				mkdirSync(join(root, 'src/data/collection/orders'), { recursive: true });
				writeFileSync(
					join(root, 'src/+workspace.ts'),
					"export default { tz: 'UTC', locale: 'en' };"
				);
				writeFileSync(
					join(root, 'src/data/model/+orders.model.ts'),
					"import {model} from '@norbital-ai/bolt'; export default model({description:'An order',label:'title',fields:{title:{kind:'text'}}});"
				);
				writeFileSync(
					join(root, 'src/data/collection/orders/+collection.ts'),
					`import {collection, type NotificationInput} from '@norbital-ai/bolt';
export default collection('orders',{read:{fields:'all'},create:{input:{columns:['title']}},notifications:{committed:[{
title:'Changed',to:(event:NotificationInput)=>event.records[0]?.values.title==='Desk' ? [{user:event.requestor ?? 'nobody'}] : []
}]}});`
				);
				const built = yield* check(root);
				expect(built.errors).toEqual([]);
				expect(built.manifest?.collections['orders']?.notifications?.committed).toEqual([
					{ title: 'Changed', to: true }
				]);
				if (built.guest === undefined) throw new Error('compiler produced no guest');
				const context = yield* Layer.build(
					guestLayer(built.guest, {
						lowerRead: () => {
							throw new Error('pure callback');
						},
						console: () => {}
					})
				);
				expect(
					yield* notificationRecipients(Context.get(context, Guest), manifest, invocation, input)
				).toEqual([{ user: 'member' }]);
			}).pipe(Effect.provide(NodeServices.layer))
	);
	it.live(
		'limits record/recipient batches and rejects a callback that tries to cross into the host',
		() =>
			Effect.gen(function* () {
				const context = yield* Layer.build(
					guestLayer(
						{
							source: `export default {collection:{orders:{spec:{notifications:{committed:[{to:async(event,ctx)=>{await ctx.get('sys_user','member');return [{user:'member'}]}}]}}}}};`
						},
						{
							lowerRead: () => {
								throw new Error('unexpected host read');
							},
							console: () => {}
						}
					)
				);
				const guest = Context.get(context, Guest);
				expect(
					yield* Effect.flip(notificationRecipients(guest, manifest, invocation, input))
				).toMatchObject({ code: 'guestError' });
				expect(
					yield* Effect.flip(
						notificationRecipients(guest, manifest, invocation, {
							...input,
							records: Array.from(
								{ length: 10001 },
								() => input.records[0] ?? { id: '', values: {} }
							)
						})
					)
				).toMatchObject({ code: 'tooLarge' });
			})
	);
});
