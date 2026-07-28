export class DdlError extends Error {
	readonly code?: string;

	constructor(message: string, options?: { code?: string; cause?: unknown }) {
		super(message, options);
		this.name = 'DdlError';
		this.code = options?.code;
	}
}

export class DdlValidationError extends DdlError {
	readonly projectId: string;
	readonly parentBranchId: string;

	constructor(
		message: string,
		args: {
			projectId: string;
			parentBranchId: string;
			cause?: unknown;
		}
	) {
		super(message, { cause: args.cause });
		this.name = 'DdlValidationError';
		this.projectId = args.projectId;
		this.parentBranchId = args.parentBranchId;
	}
}

export class DdlApplyError extends DdlError {
	readonly dbUrlMasked: string;

	constructor(
		message: string,
		args: {
			dbUrl: string;
			code?: string;
			cause?: unknown;
		}
	) {
		super(message, { code: args.code, cause: args.cause });
		this.name = 'DdlApplyError';
		this.dbUrlMasked = maskDbUrl(args.dbUrl);
	}
}

export class DdlGenerateError extends DdlError {
	readonly bundleDir: string;

	constructor(
		message: string,
		args: {
			bundleDir: string;
			code?: string;
			cause?: unknown;
		}
	) {
		super(message, { code: args.code, cause: args.cause });
		this.name = 'DdlGenerateError';
		this.bundleDir = args.bundleDir;
	}
}

function maskDbUrl(dbUrl: string): string {
	try {
		const parsed = new URL(dbUrl);
		if (parsed.username || parsed.password) {
			parsed.username = '***';
			parsed.password = '';
		}
		return parsed.toString();
	} catch {
		return '***';
	}
}
