/** Error thrown by `ServerHttp` for non-2xx answers (`body` = parsed JSON when available). */
export class ApiError extends Error {
    constructor(message: string, public readonly status: number, public readonly body: unknown = null) {
        super(message);
        this.name = "ApiError";
    }
}
