export type MinioConnectionParams = {
	readonly endPoint: string;
	readonly port: number;
	readonly useSSL: boolean;
	readonly accessKey: string;
	readonly secretKey: string;
};

export function parseMinioUrl(minioUrl: string): MinioConnectionParams {
	const u = new URL(minioUrl);
	const accessKey = decodeURIComponent(u.username);
	const secretKey = decodeURIComponent(u.password);
	if (!accessKey || !secretKey) {
		throw new Error('SECRET_MINIO_URL must include access key and secret key');
	}
	const useSSL = u.protocol === 'https:';
	const port = u.port ? parseInt(u.port, 10) : useSSL ? 443 : 80;
	return { endPoint: u.hostname, port, useSSL, accessKey, secretKey };
}

export type MinioObjectKey = {
	readonly bucket: string;
	readonly objectKey: string;
};

export function parseMinioObjectKey(key: string): MinioObjectKey {
	const slash = key.indexOf('/');
	if (slash <= 0 || slash === key.length - 1) {
		throw new Error(`MinIO file storage key must be bucket/object: ${key}`);
	}
	return { bucket: key.slice(0, slash), objectKey: key.slice(slash + 1) };
}
