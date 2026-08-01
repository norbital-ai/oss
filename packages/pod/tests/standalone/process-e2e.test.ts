import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker, startPostgres, type PgHarness } from '../support/pg-harness.js';

requireDocker();
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const POD_BIN = path.join(REPO_ROOT, 'packages/pod/build/bin/invocation/index.js');

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return address.port;
}

function waitForOutput(
	child: ChildProcessWithoutNullStreams,
	pattern: RegExp,
	timeoutMs = 30_000
): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = '';
		const timeout = setTimeout(
			() => reject(new Error(`Timed out waiting for ${pattern}: ${output}`)),
			timeoutMs
		);
		const consume = (chunk: Buffer) => {
			output += chunk.toString('utf8');
			if (!pattern.test(output)) return;
			clearTimeout(timeout);
			resolve(output);
		};
		child.stdout.on('data', consume);
		child.stderr.on('data', consume);
		child.once('exit', (code) => {
			clearTimeout(timeout);
			if (!pattern.test(output)) reject(new Error(`Pod exited ${code}: ${output}`));
		});
	});
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill('SIGTERM');
	await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

describe('Pod standalone process — E2E', () => {
	let pg: PgHarness;
	let root: string;
	let environment: NodeJS.ProcessEnv;

	beforeAll(async () => {
		pg = await startPostgres();
		const parent = path.join(REPO_ROOT, '.test-workspaces');
		await mkdir(parent, { recursive: true });
		root = await mkdtemp(path.join(parent, 'standalone-'));
		await cp(path.join(REPO_ROOT, 'template_workspaces/construction'), root, {
			recursive: true,
			filter: (source) => !source.includes(`${path.sep}.norbital${path.sep}build`)
		});
		await writeFile(
			path.join(root, 'pod.host.ts'),
			`import {
	definePodHost,
	devIdentity,
	env,
	intervalQueue,
	localFileStorage,
	postgresDb
} from '@norbital-ai/pod/host';

export default definePodHost({
	mode: 'self-hosted',
	db: postgresDb({ url: env('DATABASE_URL') }),
	publicUrl: \`http://\${env('POD_HOST')}:\${env('POD_PORT')}\`,
	identity: devIdentity({
		userId: env('POD_ADMIN_ID'),
		organizationId: env('POD_ORG_ID'),
		organizationName: env('POD_ORG_NAME')
	}),
	fileStorage: localFileStorage({ directory: '.norbital/storage' }),
	queue: intervalQueue()
});`
		);
		const port = await freePort();
		environment = {
			...process.env,
			DATABASE_URL: pg.connectionString,
			POD_HOST: '127.0.0.1',
			POD_PORT: String(port),
			POD_ORG_ID: '11111111-1111-4111-8111-111111111111',
			POD_ORG_NAME: 'Standalone Test',
			POD_ADMIN_ID: '22222222-2222-4222-8222-222222222222',
			POD_ADMIN_NAME: 'Standalone Admin',
			POD_ADMIN_EMAIL: 'admin@standalone.test',
			POD_TEMPLATE_KEY: 'construction'
		};
		execFileSync('node', [POD_BIN, 'build'], { cwd: root, env: environment, stdio: 'ignore' });
		execFileSync('node', [POD_BIN, 'migrate'], { cwd: root, env: environment, stdio: 'ignore' });
	}, 180_000);

	afterAll(async () => {
		await rm(root, { recursive: true, force: true }).catch(() => undefined);
		pg?.stop();
	});

	it('listens with complete facilities and exits before listening when a required facility is absent', async () => {
		const running = spawn('node', [POD_BIN, 'start'], {
			cwd: root,
			env: environment,
			stdio: 'pipe'
		});
		try {
			await waitForOutput(running, /Pod listening at/);
			const response = await fetch(`http://127.0.0.1:${environment.POD_PORT}/`);
			expect(response.status).toBe(200);
		} finally {
			await stop(running);
		}

		const manifestPath = path.join(root, '.norbital/build/manifest.json');
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
			automations: Record<string, unknown>;
		};
		manifest.automations.missing_ai = {
			trigger: { schedule: '0 6 * * *' },
			spec: { kind: 'agent', task: 'Require inference' }
		};
		await writeFile(manifestPath, JSON.stringify(manifest));

		const refused = spawn('node', [POD_BIN, 'start'], {
			cwd: root,
			env: environment,
			stdio: 'pipe'
		});
		const output = await waitForOutput(refused, /unavailable runtime facilities: ai/);
		expect(output).not.toContain('Pod listening at');
		if (refused.exitCode === null) {
			await new Promise<void>((resolve) => refused.once('exit', () => resolve()));
		}
		expect(refused.exitCode).not.toBe(0);
	}, 60_000);
});
