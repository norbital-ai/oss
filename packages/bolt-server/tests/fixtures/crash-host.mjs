// A bolt-server host as a process: started the way an embedder starts it, with the process policy
// installed, so a test can watch what the whole process does when a failure escapes.
//
//   CRASH_HOST_FAULT=uncaught|rejection   raise the fault on SIGUSR2
//   CRASH_HOST_FAULT=facility-late-socket  a guarded facility resolves, then a socket it opened
//                                          emits `error` with no listener, on SIGUSR2
//
// Prints `ready <baseUrl>` once listening. Stays up until stopped or killed.
import { createServer } from 'node:net';
import { EnvironmentName, ReleaseId, TenantId, success } from '@norbital-ai/bolt-protocol';
import { installProcessShutdown, startLocalApplication } from '../../src/app.ts';
import { ServerConfiguration } from '../../src/config.ts';
import { makeConfigBinding } from '../../src/facilities/providers.ts';
import { guardBinding } from '../../src/facilities/boundary.ts';

const scope = {
	tenantId: TenantId.make('crash-host'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('crash-host')
};
const fault = process.env.CRASH_HOST_FAULT ?? 'none';

/** A facility that answers, then lets a socket it created fail with nobody listening. */
const lateSocketBinding = guardBinding('late-socket', {
	call: async () => {
		const socket = createServer();
		setTimeout(() => socket.emit('error', new Error('late socket error')), 50);
		return success({ answered: true });
	}
});

const application = await startLocalApplication({
	configuration: ServerConfiguration.make({
		host: '127.0.0.1',
		port: 0,
		bundlePath: new URL('./fixture-bundle.mjs', import.meta.url).pathname,
		scope,
		mode: 'development',
		drainTimeoutMillis: 1_000,
		requestBodyLimitBytes: 1024
	}),
	facilities: { scope, config: makeConfigBinding({ BOLT_SECRETS_KEY: 'crash-host' }) }
});
installProcessShutdown(application);

// The fault is raised on SIGUSR2, not on a timer. A fixed delay races the test: a loaded runner can
// deschedule the observer for longer than the delay, so the process is already dying before the
// first readiness probe, and a short graceful stop can close the 503 window before a sample lands.
// The test signals once it has seen 200 and is polling, which makes the order deterministic. The
// handler is installed before the ready line, so the signal cannot arrive before it is registered.
const raiseFault = () => {
	if (fault === 'uncaught') throw new Error('injected uncaught exception');
	if (fault === 'rejection') void Promise.reject(new Error('injected unhandled rejection'));
	if (fault === 'facility-late-socket')
		void lateSocketBinding
			.call({ effectId: 'late-1' }, {}, new AbortController().signal)
			.then((result) => process.stdout.write(`facility ${result._tag}\n`));
};
process.on('SIGUSR2', () => {
	// `throw` from a signal handler would be swallowed by the emitter; raise it on the next tick so
	// it escapes as an uncaught exception, which is the failure the policy is meant to observe.
	if (fault === 'uncaught') setImmediate(raiseFault);
	else raiseFault();
});
process.stdout.write(`ready ${application.baseUrl}\n`);
