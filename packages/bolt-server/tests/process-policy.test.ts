import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const loader = fileURLToPath(new URL('./helpers/ts-child.mjs', import.meta.url));
const entry = fileURLToPath(new URL('./fixtures/crash-host.mjs', import.meta.url));
const TEST_TIMEOUT_MILLIS = 40_000;

type Exit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
type Host = Readonly<{
	child: ChildProcess;
	baseUrl: string;
	stdout: () => string;
	stderr: () => string;
	exited: Promise<Exit>;
}>;

const startHost = (fault: string): Promise<Host> =>
	new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--import', loader, entry], {
			env: { ...process.env, CRASH_HOST_FAULT: fault },
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let err = '';
		child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
		child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString()));
		const exited = new Promise<Exit>((settle) =>
			child.once('exit', (code, signal) => settle({ code, signal }))
		);
		const host: Host = {
			child,
			baseUrl: '',
			stdout: () => out,
			stderr: () => err,
			exited
		};
		child.stdout?.on('data', () => {
			const ready = /ready (http:\/\/[^\s]+)/.exec(out);
			if (ready?.[1] !== undefined) resolve({ ...host, baseUrl: ready[1] });
		});
		void exited.then((exit) =>
			reject(new Error(`host exited ${JSON.stringify(exit)} before ready\n${out}\n${err}`))
		);
	});

const within = <A>(promise: Promise<A>, millis: number, label: string): Promise<A> =>
	Promise.race([
		promise,
		new Promise<never>((_resolve, reject) =>
			setTimeout(() => reject(new Error(`${label} did not happen within ${millis}ms`)), millis)
		)
	]);

const readiness = async (baseUrl: string): Promise<number | 'refused'> => {
	try {
		return (await fetch(`${baseUrl}/readyz`)).status;
	} catch {
		return 'refused';
	}
};

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

/**
 * The host's readiness, polled until it answers.
 *
 * `startHost` resolves on the "ready" log line, which the child prints before the listener has
 * accepted its first connection; a single probe reads `refused` on a slower runner and failed CI
 * twice. Bounded here, so a host that never answers is still a failure rather than a hang.
 */
const waitReady = async (baseUrl: string): Promise<number> => {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const status = await readiness(baseUrl);
		if (status === 200) return status;
		if (Date.now() > deadline) throw new Error(`host never answered 200; last=${status}`);
		await sleep(10);
	}
};

describe('process policy', () => {
	const hosts: Array<Host> = [];
	afterEach(async () => {
		for (const host of hosts.splice(0)) {
			if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGKILL');
			await host.exited;
		}
	});

	/**
	 * A failure outside every facility scope is the host's own. The policy logs it, flips
	 * `/readyz` to 503, gives the graceful stop its bound, then kills the process with a signal
	 * rather than walking Node's exit path, which has hung with the port still listening. Without
	 * the policy Node's default handler exits 1 through that very path.
	 */
	for (const fault of ['uncaught', 'rejection'] as const) {
		it(
			`kills the process within the bound after an ${fault} failure escapes, refusing readiness first`,
			async () => {
				const host = await startHost(fault);
				hosts.push(host);
				expect(await waitReady(host.baseUrl)).toBe(200);
				const observed: Array<number | 'refused'> = [];
				let polling = true;
				const poll = (async () => {
					while (polling) {
						observed.push(await readiness(host.baseUrl));
						await sleep(5);
					}
				})();
				// Signal the fault only now, with the observer running, so the 503 the policy sets
				// before stopping is sampled rather than raced against a timer.
				host.child.kill('SIGUSR2');
				await sleep(15);
				const exit = await within(host.exited, 10_000, 'host exit');
				polling = false;
				await poll;
				expect(exit.signal).toBe('SIGKILL');
				expect(host.stderr()).toContain('failure escaped every boundary');
				expect(host.stderr()).toContain(`injected ${fault === 'uncaught' ? 'uncaught exception' : 'unhandled rejection'}`);
				expect(observed.some((status) => status === 503 || status === 'refused')).toBe(true);
			},
			TEST_TIMEOUT_MILLIS
		);
	}

	it(
		'contains a failure a facility raises after answering and keeps serving',
		async () => {
			const host = await startHost('facility-late-socket');
			hosts.push(host);
			host.child.kill('SIGUSR2');
			await within(
				(async () => {
					while (!host.stderr().includes('was contained')) await sleep(20);
				})(),
				10_000,
				'contained failure log'
			);
			expect(host.stdout()).toContain('facility Success');
			expect(host.stderr()).toContain('failure escaped facility late-socket (effect late-1) and was contained');
			expect(host.stderr()).toContain('late socket error');
			await sleep(300);
			expect(host.child.exitCode).toBeNull();
			expect(await readiness(host.baseUrl)).toBe(200);
			host.child.kill('SIGTERM');
			expect(await within(host.exited, 10_000, 'graceful exit')).toEqual({ code: 0, signal: null });
		},
		TEST_TIMEOUT_MILLIS
	);

	it(
		'leaves a healthy host untouched: ready, then a clean stop on SIGTERM',
		async () => {
			const host = await startHost('none');
			hosts.push(host);
			expect(await waitReady(host.baseUrl)).toBe(200);
			expect(host.stderr()).not.toContain('escaped');
			host.child.kill('SIGTERM');
			expect(await within(host.exited, 10_000, 'graceful exit')).toEqual({ code: 0, signal: null });
		},
		TEST_TIMEOUT_MILLIS
	);
});
