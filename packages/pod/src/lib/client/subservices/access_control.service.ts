import type { TScopeRequestor } from '$lib/client/types.js';

export type DynamicApplicationAuthState = {
	user: TScopeRequestor;
	isAdmin: boolean;
};

export type AccessControlServiceOptions = {
	enableBrowserIntegrations?: boolean;
};

/** Role flags for tenant UI. */
export class AccessControlService {
	state: DynamicApplicationAuthState;

	readonly #getUser: () => TScopeRequestor;

	constructor(getUser: () => TScopeRequestor, _options?: AccessControlServiceOptions) {
		this.#getUser = getUser;
		this.state = this.#createState();
	}

	get isAdmin(): boolean {
		this.#syncUser();
		return this.state.isAdmin;
	}

	destroy(): void {
		// No browser integrations in framework access control.
	}

	#createState(): DynamicApplicationAuthState {
		const user = this.#getUser();
		return {
			user,
			isAdmin: user.role === 'admin'
		};
	}

	#syncUser(): void {
		const user = this.#getUser();
		this.state.user = user;
		this.state.isAdmin = user.role === 'admin';
	}
}
