import { describe, expect, it, vi } from 'vitest';
import { PgliteWorkerBridge } from '$lib/ui/sync/replica.js';

function sharedWorkerChannel(): {
	worker: Pick<SharedWorker, 'port' | 'onerror'>;
	workerPort: MessagePort;
} {
	const channel = new MessageChannel();
	return {
		worker: { port: channel.port1, onerror: null },
		workerPort: channel.port2
	};
}

describe('PgliteWorkerBridge', () => {
	it('uses bootstrap as the first worker handshake', async () => {
		const { worker, workerPort } = sharedWorkerChannel();
		const bridge = new PgliteWorkerBridge(worker);
		const request = new Promise<{
			type: string;
			id: number;
			schemaSql: string;
			dataDir: string;
		}>((resolve) => {
			workerPort.onmessage = (event) => resolve(event.data);
			workerPort.start();
		});

		const bootstrapped = bridge.bootstrap('CREATE TABLE example(id text)', 'idb://replica');
		const message = await request;
		expect(message).toMatchObject({
			type: 'bootstrap',
			schemaSql: 'CREATE TABLE example(id text)',
			dataDir: 'idb://replica'
		});

		workerPort.postMessage({ type: 'bootstrapped', id: message.id });
		await bootstrapped;
		await bridge.close();
		workerPort.close();
	});

	it('closes only the calling tab port', async () => {
		const { worker, workerPort } = sharedWorkerChannel();
		const close = vi.spyOn(worker.port, 'close');
		const posted: unknown[] = [];
		workerPort.onmessage = (event) => posted.push(event.data);
		workerPort.start();
		const bridge = new PgliteWorkerBridge(worker);

		await bridge.close();

		expect(close).toHaveBeenCalledOnce();
		expect(posted).toEqual([]);
		workerPort.close();
	});
});
