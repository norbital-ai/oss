import { describe, expect, it, vi } from 'vitest';
import {
	fingerprintReplicaPrincipal,
	openReplicationLeadership,
	replicaPartitionKey,
	type WebLockManagerLike
} from '../../src/client/replica/leader.js';
import {
	selectReplicaStorage,
	storageBudgetFor
} from '../../src/client/replica/budget.js';
import { createSchemaBarrierController } from '../../src/client/replica/barrier.js';
import { replicaLocation } from '../../src/client/replica/pglite-loader.js';

describe('replica partition identity', () => {
	it('separates every identity dimension and never names the credential', async () => {
		const credential = 'bearer-secret-that-must-not-leak';
		const principal = await fingerprintReplicaPrincipal('identity:user-123');
		const base = {
			tenant: 'acme',
			environment: 'production',
			principal: principal.fingerprint,
			authority: 'operator',
			formatVersion: 1
		} as const;
		const key = replicaPartitionKey(base);
		expect(key).not.toContain(credential);
		expect(replicaLocation(base, 'opfs')).toMatch(/^opfs-ahp:\/\/bolt-replica::/);
		expect(replicaPartitionKey({ ...base, tenant: 'other' })).not.toBe(key);
		expect(replicaPartitionKey({ ...base, environment: 'staging' })).not.toBe(key);
		expect(replicaPartitionKey({ ...base, principal: `${base.principal}0` })).not.toBe(key);
		expect(replicaPartitionKey({ ...base, authority: 'team:field' })).not.toBe(key);
		expect(replicaPartitionKey({ ...base, formatVersion: 2 })).not.toBe(key);
	});

	it('does not collapse punctuation-bearing values onto one path', () => {
		const identity = (tenant: string) => ({
			tenant,
			environment: 'dev',
			principal: 'abc',
			authority: 'operator',
			formatVersion: 1
		});
		expect(replicaPartitionKey(identity('a/b'))).not.toBe(replicaPartitionKey(identity('a?b')));
	});
});

class FakeLocks implements WebLockManagerLike {
	private held = false;
	private readonly pending: Array<() => void> = [];

	request = async <Value>(
		name: string,
		options: { readonly ifAvailable?: boolean; readonly signal?: AbortSignal },
		callback: (lock: { readonly name: string } | null) => Value | PromiseLike<Value>
	): Promise<Value> => {
		// The real LockManager refuses this pair, and a double that accepted it let a permanently
		// failing election pass every test: leadership rejected in every browser, so no document ever
		// opened a local replica, while this suite stayed green.
		if (options.signal !== undefined && options.ifAvailable === true) {
			throw new DOMException(
				"Failed to execute 'request' on 'LockManager': The 'signal' and 'ifAvailable' options cannot be used together.",
				'NotSupportedError'
			);
		}
		if (options.ifAvailable === true && this.held) return callback(null);
		return new Promise<Value>((resolve, reject) => {
			const run = (): void => {
				this.held = true;
				void Promise.resolve(callback({ name })).then(resolve, reject).finally(() => {
					this.held = false;
					this.pending.shift()?.();
				});
			};
			if (this.held) this.pending.push(run);
			else run();
		});
	};
}

describe('replication leadership', () => {
	it('elects one explicit lock owner and transfers it after release', async () => {
		const locks = new FakeLocks();
		const first = openReplicationLeadership('partition', locks);
		const second = openReplicationLeadership('partition', locks);
		expect(await first.ready).toBe(true);
		expect(await second.ready).toBe(false);
		expect(first.leader()).toBe(true);
		expect(second.leader()).toBe(false);

		first.stop();
		await vi.waitFor(() => expect(second.leader()).toBe(true));
		second.stop();
	});

	it('asks the lock manager only for option pairs it accepts', async () => {
		const locks = new FakeLocks();
		const elected = openReplicationLeadership('partition', locks);

		expect(await elected.ready).toBe(true);
		// `failed` is the branch `startLocalReplica` reads to abandon persistence, so a rejected
		// request is not a follower — it is a server-only replica for that browser.
		expect(elected.failed()).toBe(false);
		expect(elected.leader()).toBe(true);
		elected.stop();
	});

	it('keeps a follower waiting rather than reporting a failed election', async () => {
		const locks = new FakeLocks();
		const leader = openReplicationLeadership('partition', locks);
		const follower = openReplicationLeadership('partition', locks);

		expect(await leader.ready).toBe(true);
		expect(await follower.ready).toBe(false);
		expect(follower.failed()).toBe(false);

		leader.stop();
		follower.stop();
	});
});

describe('replica storage budget', () => {
	it('prefers OPFS, adapts IndexedDB, and keeps server-only available', async () => {
		const estimate = async () => ({ usage: 10, quota: 20 * 1024 * 1024 * 1024 });
		const opfs = await selectReplicaStorage({
			estimate,
			opfs: true,
			indexeddb: true,
			webLocks: true
		});
		expect(opfs.tier).toBe('opfs');
		if (opfs.tier !== 'server-only')
			expect(opfs.budget.ceilingBytes).toBe(10 * 1024 * 1024 * 1024);

		const idb = await selectReplicaStorage({
			estimate,
			opfs: false,
			indexeddb: true,
			webLocks: true
		});
		expect(idb.tier).toBe('indexeddb');
		if (idb.tier !== 'server-only')
			expect(idb.budget.ceilingBytes).toBeLessThanOrEqual(512 * 1024 * 1024);

		expect(
			await selectReplicaStorage({ estimate, opfs: true, indexeddb: true, webLocks: false })
		).toMatchObject({ tier: 'server-only' });
	});

});

describe('schema barriers', () => {
	it('withdraws readers and switches physical namespace without mutating the old replica', async () => {
		const durable = { generation: 1, fingerprint: 'one', protocolVersion: 1 };
		const events: Array<string> = [];
		const barrier = {
			generation: 2,
			fingerprint: 'two',
			minimumProtocolVersion: 1,
			affectedCollections: ['jobs'],
			migrationDigest: 'sha256:two'
		};
		const controller = createSchemaBarrierController({
			leader: () => true,
			readDurable: async () => durable,
			withdrawReaders: (collections) => events.push(`withdraw:${collections.join(',')}`),
			switchNamespace: async (next) => {
				events.push(`switch:${next.generation}:${next.fingerprint}`);
			}
		});

		await controller.accept(barrier);
		expect(events).toEqual(['withdraw:jobs', 'switch:2:two']);
		expect(durable).toEqual({ generation: 1, fingerprint: 'one', protocolVersion: 1 });
		expect(controller.state()).toMatchObject({ phase: 'switching-namespace', generation: 2 });
	});

	it('uses the same namespace switch for a barrier from a newer protocol', async () => {
		const events: Array<string> = [];
		const controller = createSchemaBarrierController({
			leader: () => true,
			readDurable: async () => ({ generation: 1, fingerprint: 'one', protocolVersion: 1 }),
			withdrawReaders: () => events.push('withdraw'),
			switchNamespace: async () => {
				events.push('switch');
			}
		});
		await controller.accept({
			generation: 2,
			fingerprint: 'two',
			minimumProtocolVersion: 2,
			affectedCollections: ['jobs'],
			migrationDigest: 'sha256:two'
		});
		expect(events).toEqual(['withdraw', 'switch']);
		expect(controller.state().phase).toBe('switching-namespace');
	});
});
