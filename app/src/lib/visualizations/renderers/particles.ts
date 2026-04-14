import type { VisualizationDef, AudioData, RenderConfig } from "../types";
import { PALETTES, VARIANT_PALETTES } from "../palettes";
import { getColorInterp, clearCanvas, hexToRgba, capitalize } from "../viz-utils";

type ParticleType = "fountain" | "explosion" | "constellation" | "fireflies" | "nebula";

interface Particle {
    x: number; y: number; vx: number; vy: number;
    life: number; maxLife: number; size: number; colorIdx: number;
}

// Persistent particle pools per visualization instance
const particlePools = new Map<string, Particle[]>();

function getPool(id: string, maxParticles: number): Particle[] {
    if (!particlePools.has(id)) {
        particlePools.set(id, []);
    }
    return particlePools.get(id)!;
}

function renderParticles(
    ctx: CanvasRenderingContext2D,
    data: AudioData,
    config: RenderConfig,
    type: ParticleType,
    palette: string[],
    id: string,
) {
    const { width: w, height: h, deltaTime, sensitivity, mouse } = config;
    const maxP = config.quality === "high" ? 400 : config.quality === "medium" ? 250 : 120;
    const pool = getPool(id, maxP);
    const dt = Math.min(deltaTime, 0.05);

    // Spawn particles based on audio energy
    const spawnRate = Math.floor((data.bass + data.mid) * sensitivity * 8);

    for (let s = 0; s < spawnRate && pool.length < maxP; s++) {
        const p = spawnParticle(type, w, h, data, sensitivity);
        pool.push(p);
    }

    // Beat burst
    if (data.beat && pool.length < maxP - 20) {
        for (let i = 0; i < 20; i++) {
            pool.push(spawnParticle(type, w, h, data, sensitivity));
        }
    }

    clearCanvas(ctx, w, h, type === "nebula" ? 0.05 : 0);

    // Update & draw
    for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i];
        p.life -= dt;
        if (p.life <= 0) { pool.splice(i, 1); continue; }

        // Mouse attraction for interactive types
        if (mouse.active && (type === "fireflies" || type === "constellation")) {
            const dx = mouse.x * w - p.x;
            const dy = mouse.y * h - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0 && dist < 200) {
                p.vx += (dx / dist) * 0.5;
                p.vy += (dy / dist) * 0.5;
            }
        }

        // Physics
        switch (type) {
            case "fountain":
                p.vy += 120 * dt; // gravity
                break;
            case "explosion":
                p.vx *= 0.98;
                p.vy *= 0.98;
                break;
            case "nebula":
                p.vx += (Math.random() - 0.5) * 20 * dt;
                p.vy += (Math.random() - 0.5) * 20 * dt;
                p.vx *= 0.99;
                p.vy *= 0.99;
                break;
            case "fireflies":
                p.vx += (Math.random() - 0.5) * 50 * dt;
                p.vy += (Math.random() - 0.5) * 50 * dt;
                p.vx *= 0.95;
                p.vy *= 0.95;
                break;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;

        const alpha = Math.min(1, p.life / p.maxLife);
        const color = getColorInterp(palette, p.colorIdx);

        ctx.beginPath();
        const r = p.size * (0.5 + alpha * 0.5);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(color, alpha);
        ctx.fill();

        if (type === "fireflies" || type === "nebula") {
            ctx.shadowColor = color;
            ctx.shadowBlur = r * 3;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r * 0.5, 0, Math.PI * 2);
            ctx.fillStyle = hexToRgba(color, alpha * 0.8);
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    }

    // Constellation: draw lines between nearby particles
    if (type === "constellation") {
        ctx.lineWidth = 0.5;
        for (let i = 0; i < pool.length; i++) {
            for (let j = i + 1; j < Math.min(pool.length, i + 20); j++) {
                const dx = pool[i].x - pool[j].x;
                const dy = pool[i].y - pool[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    const alpha = (1 - dist / 120) * 0.3;
                    ctx.strokeStyle = hexToRgba(palette[0], alpha);
                    ctx.beginPath();
                    ctx.moveTo(pool[i].x, pool[i].y);
                    ctx.lineTo(pool[j].x, pool[j].y);
                    ctx.stroke();
                }
            }
        }
    }
}

function spawnParticle(type: ParticleType, w: number, h: number, data: AudioData, sens: number): Particle {
    const energy = (data.bass + data.volume) * sens;
    switch (type) {
        case "fountain":
            return {
                x: w / 2 + (Math.random() - 0.5) * 40,
                y: h * 0.9,
                vx: (Math.random() - 0.5) * 100 * energy,
                vy: -200 - Math.random() * 200 * energy,
                life: 2 + Math.random() * 2,
                maxLife: 4,
                size: 2 + Math.random() * 4,
                colorIdx: Math.random(),
            };
        case "explosion":
            const angle = Math.random() * Math.PI * 2;
            const speed = 50 + Math.random() * 200 * energy;
            return {
                x: w / 2, y: h / 2,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1 + Math.random() * 2,
                maxLife: 3,
                size: 2 + Math.random() * 5 * energy,
                colorIdx: Math.random(),
            };
        case "constellation":
            return {
                x: Math.random() * w, y: Math.random() * h,
                vx: (Math.random() - 0.5) * 30,
                vy: (Math.random() - 0.5) * 30,
                life: 3 + Math.random() * 4,
                maxLife: 7,
                size: 2 + Math.random() * 3,
                colorIdx: Math.random(),
            };
        case "fireflies":
            return {
                x: Math.random() * w, y: Math.random() * h,
                vx: (Math.random() - 0.5) * 40,
                vy: (Math.random() - 0.5) * 40,
                life: 2 + Math.random() * 5,
                maxLife: 7,
                size: 1.5 + Math.random() * 3,
                colorIdx: Math.random(),
            };
        case "nebula":
            return {
                x: w / 2 + (Math.random() - 0.5) * w * 0.5,
                y: h / 2 + (Math.random() - 0.5) * h * 0.5,
                vx: (Math.random() - 0.5) * 20,
                vy: (Math.random() - 0.5) * 20,
                life: 4 + Math.random() * 6,
                maxLife: 10,
                size: 5 + Math.random() * 15 * energy,
                colorIdx: Math.random(),
            };
    }
}

const TYPES: ParticleType[] = ["fountain", "explosion", "constellation", "fireflies", "nebula"];
const NAMES: Record<ParticleType, string> = {
    fountain: "Fountain", explosion: "Explosion", constellation: "Constellation",
    fireflies: "Fireflies", nebula: "Nebula",
};

export function createParticleVisualizations(): VisualizationDef[] {
    return TYPES.flatMap((type) =>
        VARIANT_PALETTES.map((palName) => {
            const id = `particles-${type}-${palName}`;
            return {
                id,
                name: `${NAMES[type]} · ${capitalize(palName)}`,
                category: "Particles",
                tags: ["particles", type, palName],
                interactive: type === "fireflies" || type === "constellation",
                render: (ctx: CanvasRenderingContext2D, data: AudioData, config: RenderConfig) =>
                    renderParticles(ctx, data, config, type, PALETTES[palName], id),
            };
        })
    );
}
