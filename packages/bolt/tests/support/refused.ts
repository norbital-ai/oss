// Members a test host serves none of: each call rejects as the facility's `Unavailable`.
import { type FilesPort, Unavailable } from '@norbital-ai/host-api';

export const refused = (facility: string) => () =>
	Promise.reject(new Unavailable({ facility, reason: `the host provides no ${facility}` }));

export const refused_files: FilesPort = {
	put: refused('files'),
	get: refused('files'),
	url: refused('files'),
	remove: refused('files'),
	download: refused('files')
};
