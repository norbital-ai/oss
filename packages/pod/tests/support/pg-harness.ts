import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export type PgHarness = {
	readonly connectionString: string;
	stop(): void;
};

const IMAGE = 'norbital-pod-postgres-temporal:18-1.2.2';
const IMAGE_CONTEXT = fileURLToPath(new URL('./postgres-temporal', import.meta.url));
/** Marks every container this harness creates, so strays can be found and reaped. */
const LABEL = 'norbital-pg-harness';
/** Records the owning process, so a reaper can tell a live run from an abandoned one. */
const OWNER_LABEL = 'norbital-pg-owner';

/** Fail collection immediately when a real-Postgres suite cannot reach Docker. */
export function requireDocker(): void {
	try {
		execFileSync('docker', ['info'], { stdio: 'ignore' });
	} catch (cause) {
		throw new Error(
			'Docker is required for Pod integration tests; refusing to report a green run with the real-Postgres suites skipped.',
			{ cause }
		);
	}
}

function ensurePostgresImage(): void {
	try {
		execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
		return;
	} catch {
		execFileSync('docker', ['build', '--load', '--tag', IMAGE, IMAGE_CONTEXT], {
			stdio: 'inherit'
		});
	}
}

function removeContainer(containerId: string): void {
	// `-v` is load-bearing: the postgres image declares its data directory as a VOLUME, so every
	// container creates an anonymous volume. Removing the container without it leaks that volume
	// forever — a few hundred megabytes per test run, which is what filled the Docker disk.
	execFileSync('docker', ['rm', '-f', '-v', containerId], { stdio: 'ignore' });
}

/**
 * Remove harness containers whose owning process is gone. A run that was killed (Ctrl-C, a crashed
 * worker, an OOM) never reaches its own teardown, so without this the strays accumulate silently.
 * Containers belonging to a *live* process are left alone, so concurrent runs are safe.
 */
function reapAbandonedContainers(): void {
	try {
		// `docker ps` supports `label=` but not `label!=`, so filter by owner PID below instead.
		const listed = execFileSync('docker', ['ps', '-aq', '--filter', `label=${LABEL}`], {
			encoding: 'utf8'
		})
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		if (listed.length === 0) return;

		const owners = execFileSync(
			'docker',
			['inspect', '--format', `{{.Id}} {{index .Config.Labels "${OWNER_LABEL}"}}`, ...listed],
			{ encoding: 'utf8' }
		);
		for (const line of owners.split('\n')) {
			const [id, owner] = line.trim().split(' ');
			if (!id || !owner) continue;
			const pid = Number(owner);
			// Leave anything a live process still owns — including this run's own containers, and
			// any concurrent vitest invocation.
			if (!Number.isFinite(pid) || processAlive(pid)) continue;
			removeContainer(id);
		}
	} catch {
		// Reaping is best-effort housekeeping; never fail a test run over it.
	}
}

function processAlive(pid: number): boolean {
	try {
		// Signal 0 checks for existence without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function hostPort(containerId: string): number {
	const raw = execFileSync('docker', ['port', containerId, '5432/tcp'], {
		encoding: 'utf8'
	});
	// e.g. "0.0.0.0:54321\n[::]:54321\n" — take the first mapping's port.
	for (const line of raw.split('\n')) {
		const match = line.trim().match(/:(\d+)$/);
		if (match) return Number(match[1]);
	}
	throw new Error(`Could not parse mapped port from: ${raw}`);
}

async function waitForReady(connectionString: string): Promise<void> {
	const deadline = Date.now() + 60_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const client = new Client({ connectionString });
		try {
			await client.connect();
			await client.query('SELECT 1');
			await client.end();
			return;
		} catch (err) {
			lastError = err;
			await client.end().catch(() => {});
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	throw new Error(`Postgres never became ready: ${String(lastError)}`);
}

/** Containers this process owns and has not torn down yet, for the exit-time safety net. */
const live = new Set<string>();
let exitHookInstalled = false;

/**
 * Last-resort teardown. `afterAll` does not run when the process is killed or throws its way out,
 * and a leaked container holds both a port and a data volume until someone notices by hand.
 */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	const cleanup = () => {
		for (const containerId of live) {
			try {
				removeContainer(containerId);
			} catch {
				// nothing useful to do while exiting
			}
		}
		live.clear();
	};
	process.once('exit', cleanup);
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.once(signal, () => {
			cleanup();
			process.exit(130);
		});
	}
}

/** Boot a throwaway Postgres 18 container and return its connection string + teardown. */
export async function startPostgres(): Promise<PgHarness> {
	installExitHook();
	reapAbandonedContainers();
	ensurePostgresImage();

	const containerId = execFileSync(
		'docker',
		[
			'run',
			'-d',
			'-P',
			'--label',
			LABEL,
			'--label',
			`${OWNER_LABEL}=${process.pid}`,
			'-e',
			'POSTGRES_PASSWORD=postgres',
			'-e',
			'POSTGRES_DB=poddb',
			IMAGE
		],
		{ encoding: 'utf8' }
	).trim();
	live.add(containerId);

	try {
		const port = hostPort(containerId);
		const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/poddb`;
		await waitForReady(connectionString);
		return {
			connectionString,
			stop() {
				live.delete(containerId);
				removeContainer(containerId);
			}
		};
	} catch (err) {
		live.delete(containerId);
		removeContainer(containerId);
		throw err;
	}
}
