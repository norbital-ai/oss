// A bolt-server host as a process: started the way an embedder starts it, with the process policy
// installed, so a test can watch what the whole process does when a failure escapes.
//
//   CRASH_HOST_FAULT=uncaught|rejection   raise the fault 100ms after `/readyz` answered 200
//   CRASH_HOST_FAULT=facility-late-socket  a guarded facility resolves, then a socket it opened
//                                          emits `error` with no listener
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
		invocationTimeoutMillis: 1_000,
		requestBodyLimitBytes: 1024
	}),
	facilities: { scope, config: makeConfigBinding({ BOLT_SECRETS_KEY: 'crash-host' }) }
});
installProcessShutdown(application);
process.stdout.write(`ready ${application.baseUrl}\n`);

setTimeout(() => {
	if (fault === 'uncaught') throw new Error('injected uncaught exception');
	if (fault === 'rejection') void Promise.reject(new Error('injected unhandled rejection'));
	if (fault === 'facility-late-socket')
		void lateSocketBinding
			.call({ effectId: 'late-1' }, {}, new AbortController().signal)
			.then((result) => process.stdout.write(`facility ${result._tag}\n`));
}, 100);
