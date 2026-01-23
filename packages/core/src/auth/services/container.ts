/**
 * @file container.ts
 * Service container for managing singleton service instances.
 *
 * @license Apache-2.0
 */

import type { AccountService } from "./account-service";
import { createAccountService } from "./account-service";
import type { PasswordService } from "./password-service";
import { createPasswordService } from "./password-service";
import type { SessionService } from "./session-service";
import { createSessionService } from "./session-service";
import type { TokenService } from "./token-service";
import { createTokenService } from "./token-service";

/**
 * Registry of all available services.
 */
interface ServiceRegistry {
	passwordService: PasswordService;
	sessionService: SessionService;
	accountService: AccountService;
	tokenService: TokenService;
}

/**
 * Global service container ensuring singleton instances
 * and consistent service initialization.
 */
export class ServiceContainer {
	private static instance: ServiceContainer;
	private services = new Map<keyof ServiceRegistry, unknown>();

	private constructor() {}

	static getInstance(): ServiceContainer {
		if (!ServiceContainer.instance) {
			ServiceContainer.instance = new ServiceContainer();
		}
		return ServiceContainer.instance;
	}

	/**
	 * Initializes all application services.
	 * Should be called once during application startup.
	 */
	initializeServices(): void {
		const passwordService = createPasswordService();
		this.services.set("passwordService", passwordService);
		this.services.set("sessionService", createSessionService());
		this.services.set(
			"accountService",
			createAccountService({ passwordService }),
		);
		this.services.set("tokenService", createTokenService());
	}

	/**
	 * Gets a service instance, ensuring type safety.
	 */
	getService<K extends keyof ServiceRegistry>(key: K): ServiceRegistry[K] {
		const service = this.services.get(key);
		if (!service) {
			throw new Error(`Service ${key} not initialized`);
		}
		return service as ServiceRegistry[K];
	}

	/**
	 * Resets the container for testing purposes.
	 * Clears all registered services.
	 */
	reset(): void {
		this.services.clear();
	}
}

/**
 * Get the global service container instance.
 * Creates the instance if it doesn't exist.
 */
export function getServiceContainer(): ServiceContainer {
	return ServiceContainer.getInstance();
}
