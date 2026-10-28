// Members a test host serves none of: each call rejects as the facility's `Unavailable`.
import { Unavailable } from '../../src/decl/errors.ts';
import type { FilesPort } from '../../src/engine/contracts.ts';

export const refused = (facility: string) => () =>
	Promise.reject(new Unavailable({ facility, reason: `the host provides no ${facility}` }));

export const refusedFiles: FilesPort = {
	put: refused('files'),
	get: refused('files'),
	url: refused('files'),
	remove: refused('files'),
	download: refused('files')
};
