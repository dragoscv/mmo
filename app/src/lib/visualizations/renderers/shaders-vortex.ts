import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const VORTEX_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Spiral Vortex",
        tags: ["vortex", "spiral", "hypnotic"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float t = u_time * 0.5;
    float spiral = a + r * 8.0 - t * 2.0;
    float v = sin(spiral * 3.0 + u_bass * 5.0) * 0.5 + 0.5;
    v *= smoothstep(1.2, 0.0, r);
    float f = freq(r * 0.4);
    vec3 col = palette(v + r * 0.5 + t * 0.05);
    col *= v * (1.0 + f * 1.5);
    col += palette(a / TAU) * exp(-r * 3.0) * u_volume;
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Black Hole",
        tags: ["vortex", "blackhole", "gravity"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float t = u_time * 0.3;
    float warp = 1.0 / (r + 0.1) * 0.1;
    vec2 p = uv * rot2(warp + t);
    float disk = exp(-abs(p.y) * 10.0 / (r + 0.1)) * smoothstep(0.05, 0.15, r);
    float accretion = sin(a * 6.0 + 1.0/r * 3.0 - t * 5.0) * 0.5 + 0.5;
    disk *= accretion;
    float glow = exp(-r * 4.0) * u_bass;
    float f = freq(a / TAU * 0.5 + 0.25);
    vec3 col = palette(a / TAU + r + t * 0.05) * disk * 2.0;
    col += palette(0.1) * glow * 3.0;
    col *= 1.0 + f * 1.0 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Tornado",
        tags: ["vortex", "tornado", "wind"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float t = u_time * 0.4;
    float twist = a + r * 12.0 * (1.0 + u_bass) - t * 3.0;
    float wind = fbm(vec2(twist, r * 3.0 - t));
    float cone = smoothstep(0.8, 0.0, abs(uv.x) * 2.0) * smoothstep(-0.5, 0.5, uv.y);
    float v = wind * cone;
    float f = freq(r * 0.5);
    vec3 col = palette(wind + r + t * 0.03) * v * 2.0;
    col += palette(0.7) * exp(-length(uv - vec2(0.0, 0.3)) * 5.0) * u_volume;
    col *= 1.0 + u_beat * 0.5 + f * 0.8;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createVortexShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of VORTEX_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-vortex-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Vortex",
                tags: [...shader.tags, "shader", "webgl", pal.name.toLowerCase()],
                render: noopRender,
                shader: {
                    fragment: buildShader(shader.body),
                    palette: pal.colors,
                },
            });
        }
    }
    return results;
}
