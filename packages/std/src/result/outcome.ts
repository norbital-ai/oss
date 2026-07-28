type SuccessBranch<T, E> = {
	readonly result: T;
	readonly error: null;
	map<U>(fn: (v: T) => U): Outcome<U, E>;
	mapErr<F>(): Outcome<T, F>;
	flatMap<U>(fn: (v: T) => Outcome<U, E>): Outcome<U, E>;
	unwrapOr<U>(_fallback: U): T | U;
	match<U>(onSuccess: (v: T) => U, _onFailure: (e: E) => U): U;
	unwrap(): T;
};

type FailureBranch<T, E> = {
	readonly result: null;
	readonly error: E;
	map<U>(): Outcome<U, E>;
	mapErr<F>(fn: (e: E) => F): Outcome<T, F>;
	flatMap<U>(): Outcome<U, E>;
	unwrapOr<U>(fallback: U): U;
	match<U>(_onSuccess: (v: T) => U, onFailure: (e: E) => U): U;
	unwrap(): T;
};

export type Outcome<T, E = Error> = SuccessBranch<T, E> | FailureBranch<T, E>;

export function success<T, E = never>(value: T): SuccessBranch<T, E> {
	return {
		result: value,
		error: null,
		map<U>(fn: (v: T) => U): Outcome<U, E> {
			return success<U, E>(fn(value));
		},
		mapErr<F>(): Outcome<T, F> {
			return success<T, F>(value);
		},
		flatMap<U>(fn: (v: T) => Outcome<U, E>): Outcome<U, E> {
			return fn(value);
		},
		unwrapOr<U>(_fallback: U): T | U {
			return value;
		},
		match<U>(onSuccess: (v: T) => U, _onFailure: (e: E) => U): U {
			return onSuccess(value);
		},
		unwrap(): T {
			return value;
		}
	};
}

function _failure<T, E>(error: E): FailureBranch<T, E> {
	return {
		result: null,
		error,
		map<U>(): Outcome<U, E> {
			return _failure<U, E>(error);
		},
		mapErr<F>(fn: (e: E) => F): Outcome<T, F> {
			return _failure<T, F>(fn(error));
		},
		flatMap<U>(): Outcome<U, E> {
			return _failure<U, E>(error);
		},
		unwrapOr<U>(fallback: U): U {
			return fallback;
		},
		match<U>(_onSuccess: (v: T) => U, onFailure: (e: E) => U): U {
			return onFailure(error);
		},
		unwrap(): T {
			throw error;
		}
	};
}

export function failure<T = never, E = Error>(error: E): FailureBranch<T, E> {
	return _failure(error);
}

// stupidity:allow R5b -- canonical discriminant guard for the Outcome union
export function isSuccess<T, E>(outcome: Outcome<T, E>): outcome is SuccessBranch<T, E> {
	return outcome.error === null;
}

// stupidity:allow R5b -- canonical discriminant guard for the Outcome union
export function isFailure<T, E>(outcome: Outcome<T, E>): outcome is FailureBranch<T, E> {
	return outcome.error !== null;
}
