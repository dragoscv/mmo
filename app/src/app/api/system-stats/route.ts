import si from "systeminformation";

export const dynamic = "force-dynamic";

interface SystemSnapshot {
    cpuUsage: number;         // 0-100 %
    cpuTemp: number;          // °C (0 if unavailable)
    cpuModel: string;
    cpuCores: number;
    ramUsed: number;          // MB
    ramTotal: number;         // MB
    ramUsage: number;         // 0-100 %
    gpuUsage: number;         // 0-100 % (0 if unavailable)
    gpuTemp: number;          // °C (0 if unavailable)
    gpuModel: string;
    gpuVram: number;          // MB used (0 if unavailable)
    gpuVramTotal: number;     // MB total (0 if unavailable)
    gpuIndex: number;
    availableGpus: { index: number; model: string; vramTotal: number }[];
    timestamp: number;
}

// Cache static info that doesn't change (CPU model, cores, GPU list)
let cachedStaticInfo: {
    cpuModel: string;
    cpuCores: number;
    availableGpus: { index: number; model: string; vramTotal: number }[];
} | null = null;

async function getStaticInfo() {
    if (cachedStaticInfo) return cachedStaticInfo;
    const [cpuInfo, graphics] = await Promise.all([si.cpu(), si.graphics()]);
    const controllers = graphics.controllers ?? [];
    cachedStaticInfo = {
        cpuModel: `${cpuInfo.manufacturer} ${cpuInfo.brand}`,
        cpuCores: cpuInfo.cores,
        availableGpus: controllers.map((c, i) => ({
            index: i,
            model: c.model ?? `GPU ${i}`,
            vramTotal: c.memoryTotal ?? 0,
        })),
    };
    return cachedStaticInfo;
}

async function collectStats(gpuIndex: number): Promise<SystemSnapshot> {
    const [staticInfo, cpu, cpuTemp, mem, graphics] = await Promise.all([
        getStaticInfo(),
        si.currentLoad(),
        si.cpuTemperature(),
        si.mem(),
        si.graphics(),
    ]);

    const controllers = graphics.controllers ?? [];
    const idx = Math.min(gpuIndex, Math.max(0, controllers.length - 1));
    const gpu = controllers[idx];

    return {
        cpuUsage: Math.round(cpu.currentLoad * 10) / 10,
        cpuTemp: cpuTemp.main ?? 0,
        cpuModel: staticInfo.cpuModel,
        cpuCores: staticInfo.cpuCores,
        ramUsed: Math.round(mem.used / 1048576),
        ramTotal: Math.round(mem.total / 1048576),
        ramUsage: Math.round((mem.used / mem.total) * 1000) / 10,
        gpuUsage: gpu?.utilizationGpu ?? 0,
        gpuTemp: gpu?.temperatureGpu ?? 0,
        gpuModel: gpu?.model ?? "N/A",
        gpuVram: gpu?.memoryUsed ?? 0,
        gpuVramTotal: gpu?.memoryTotal ?? 0,
        gpuIndex: idx,
        availableGpus: staticInfo.availableGpus,
        timestamp: Date.now(),
    };
}

export async function GET(request: Request) {
    const url = new URL(request.url);
    const gpuIndex = parseInt(url.searchParams.get("gpu") ?? "0", 10) || 0;
    const pollMs = Math.max(2000, Math.min(30000,
        parseInt(url.searchParams.get("interval") ?? "5000", 10) || 5000
    ));
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        start(controller) {
            const send = (data: SystemSnapshot) => {
                try {
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
                    );
                } catch {
                    // Stream closed
                }
            };

            let stopped = false;

            // Collect and send stats every N seconds
            const poll = async () => {
                while (!stopped) {
                    try {
                        const stats = await collectStats(gpuIndex);
                        send(stats);
                    } catch {
                        // systeminformation can throw on some platforms
                    }
                    await new Promise((r) => setTimeout(r, pollMs));
                }
            };

            poll();

            // Heartbeat every 15s
            const heartbeat = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(`: heartbeat\n\n`));
                } catch {
                    clearInterval(heartbeat);
                }
            }, 15000);

            // Cleanup on client disconnect
            request.signal.addEventListener("abort", () => {
                stopped = true;
                clearInterval(heartbeat);
                try {
                    controller.close();
                } catch {
                    // Already closed
                }
            });
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-store",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
