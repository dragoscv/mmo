/**
 * Typed client for the MMO Server REST API.
 *
 * Types are generated from `server/openapi.yaml` into
 * `src/generated/mmo-server.d.ts` (`pnpm gen:openapi`); the runtime is
 * `openapi-fetch`, a ~2 kB wrapper around `fetch` that keeps path, query,
 * body and response types tied to the spec.
 *
 * ```ts
 * const mmo = createMmoServerClient({ baseUrl: "http://192.168.1.10:17899", token });
 * const { data, error } = await mmo.GET("/health");
 * const scan = await mmo.POST("/video/scan", { body: { roots: ["D:/Movies"] } });
 * ```
 */
import createClient, { type Client, type ClientOptions } from "openapi-fetch";

import type { paths } from "./generated/mmo-server.js";

export type { paths, components, operations } from "./generated/mmo-server.js";

/** Convenience aliases for the schemas external callers use most. */
export type MmoServerSchemas = import("./generated/mmo-server.js").components["schemas"];
export type MmoHealth = MmoServerSchemas["Health"];
export type MmoTrack = MmoServerSchemas["Track"];
export type MmoVideoFile = MmoServerSchemas["VideoFile"];
export type MmoPairInfo = MmoServerSchemas["PairInfo"];

export interface MmoServerClientOptions extends Omit<ClientOptions, "baseUrl"> {
    /** Origin of the companion, e.g. `http://192.168.1.10:17899`. Trailing slashes are ignored. */
    baseUrl: string;
    /**
     * Device token from pairing. Sent as `x-device-token` on every request.
     * Omit it only for the unauthenticated routes (`/health`, `/pair/info`, …).
     */
    token?: string;
    /** User id sent as `x-user-id`; required by `/library/*`, `/voice/*`, `/plugins/*` and `/mixai-profile`. */
    userId?: string;
}

export type MmoServerClient = Client<paths>;

/** Build a typed client bound to one companion. */
export function createMmoServerClient(options: MmoServerClientOptions): MmoServerClient {
    const { baseUrl, token, userId, headers, ...rest } = options;
    return createClient<paths>({
        ...rest,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        headers: {
            ...(token ? { "x-device-token": token } : {}),
            ...(userId ? { "x-user-id": userId } : {}),
            ...headers,
        },
    });
}
