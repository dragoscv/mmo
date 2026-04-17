import { handlers } from "@/auth";
import { NextRequest } from "next/server";

function fixTunnelUrl(request: NextRequest): NextRequest {
    const xfh = request.headers.get("x-forwarded-host");
    const xfp = request.headers.get("x-forwarded-proto");

    // VS Code dev tunnel: rewrite request URL to match the tunnel origin
    if (xfh && xfp && xfh.includes("devtunnels.ms")) {
        const tunnelOrigin = `${xfp}://${xfh}`;
        const url = new URL(request.nextUrl.pathname + request.nextUrl.search, tunnelOrigin);
        return new NextRequest(url, request);
    }
    return request;
}

export const GET = (request: NextRequest) => handlers.GET!(fixTunnelUrl(request));
export const POST = (request: NextRequest) => handlers.POST!(fixTunnelUrl(request));
