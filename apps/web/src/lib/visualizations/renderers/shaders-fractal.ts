import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const FRACTAL_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Mandelbrot Pulse",
        tags: ["fractal", "mandelbrot", "zoom"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float zoom = 2.0 + sin(u_time * 0.2) * u_bass * 1.5;
    vec2 c = uv * zoom + vec2(-0.5, 0.0);
    vec2 z = vec2(0.0);
    float iter = 0.0;
    for (int i = 0; i < 64; i++) {
        z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
        if (dot(z, z) > 4.0) break;
        iter += 1.0;
    }
    float t = iter / 64.0 + u_time * 0.05;
    float f = freq(iter / 64.0);
    vec3 col = palette(t + f * 0.5) * (1.0 - iter / 64.0 * 0.5);
    col *= 1.0 + u_beat * 0.5 + u_volume * 0.3;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Julia Dance",
        tags: ["fractal", "julia", "dance"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y * 2.5;
    vec2 c = vec2(
        -0.8 + sin(u_time * 0.3 + u_bass) * 0.2,
        0.156 + cos(u_time * 0.2 + u_mid) * 0.2
    );
    vec2 z = uv;
    float iter = 0.0;
    for (int i = 0; i < 80; i++) {
        z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
        if (dot(z, z) > 4.0) break;
        iter += 1.0;
    }
    float t = iter / 80.0;
    vec3 col = palette(t + u_time * 0.02);
    col *= pow(t, 0.5) * 2.0;
    col *= 1.0 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Fractal Flame",
        tags: ["fractal", "flame", "organic"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float scale = 3.0 + u_bass;
    vec2 p = uv * scale;
    float v = 0.0;
    for (int i = 0; i < 6; i++) {
        p = abs(p) / dot(p, p) - vec2(1.0 + sin(u_time * 0.1) * 0.3);
        v += length(p) * 0.1;
    }
    float f = freq(v * 0.2);
    vec3 col = palette(v * 0.2 + u_time * 0.03 + f) * v * 0.5;
    col *= 1.0 + u_beat * 0.5 + u_treble * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createFractalShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of FRACTAL_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-fractal-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Fractal",
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
