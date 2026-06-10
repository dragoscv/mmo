import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const FLUID_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Fluid Flow",
        tags: ["fluid", "flow", "smooth"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec2 p = uv * 3.0;
    for (int i = 0; i < 6; i++) {
        p += sin(p.yx * 1.4 + t + float(i) * 0.5) * 0.6;
    }
    float v = sin(p.x + p.y) * 0.5 + 0.5;
    v += u_bass * sin(length(uv) * 8.0 - t * 3.0) * 0.3;
    float f = freq(length(uv) * 0.3);
    vec3 col = palette(v + f * 0.4 + u_time * 0.02);
    col *= 0.7 + u_volume * 0.5 + u_beat * 0.3;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Smoke Tendrils",
        tags: ["fluid", "smoke", "tendrils"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.2;
    vec2 p = uv * 2.0;
    float v = 0.0;
    for (int i = 0; i < 4; i++) {
        float fi = float(i);
        vec2 q = p + sin(p.yx * (1.5 + fi * 0.3) + t * (0.5 + fi * 0.1)) * 0.8;
        v += sin(q.x * 3.0 + q.y * 3.0 + t) / (2.0 + fi);
    }
    v += u_mid * fbm(p + t) * 0.5;
    vec3 col = palette(v * 0.5 + u_time * 0.01) * (0.5 + abs(v));
    col *= 1.0 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Ink Drop",
        tags: ["fluid", "ink", "diffusion"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.25;
    float d = length(uv);
    vec2 p = uv * 4.0;
    float n1 = fbm(p + t * 0.5);
    float n2 = fbm(p * 2.0 + n1 * 2.0 + t * 0.3);
    float v = n1 + n2 * 0.5;
    float drop = smoothstep(0.8 + u_bass * 0.3, 0.0, d) * 1.5;
    v += drop;
    float f = freq(d * 0.5);
    vec3 col = palette(v * 0.3 + f * 0.3) * v * 0.7;
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createFluidShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of FLUID_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-fluid-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Fluid",
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
