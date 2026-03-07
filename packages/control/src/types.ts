/**
 * @file types.ts
 * Shared types for the control bridge plugin (ADR-010).
 * Plugin-only – removable with packages/control.
 *
 * @license Apache-2.0
 */

import type { Env, Variables } from "@private-landing/types";

export interface ControlBindings extends Env {
	GATEWAY_URL?: string;
	GATEWAY_TOKEN?: string;
	CONTROL_ALLOWED_IPS?: string;
}

export type ControlEnv = { Bindings: ControlBindings; Variables: Variables };
