import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const PLASMA_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Classic Plasma",
        tags: ["plasma", "retro", "smooth"],
        body: `
    vec2 uv = gl_FragCoord.xy / u_resolution;
    float t = u_time * 0.5;
    float v = sin(uv.x * 10.0 + t);
    v += sin(uv.y * 10.0 + t * 0.7);
    v += sin((uv.x + uv.y) * 10.0 + t * 0.5);
    v += sin(length(uv - 0.5) * 14.0 - t);
    v = v * 0.25 + 0.5;
    float f = freq(v);
    v += u_bass * 0.3 * sin(uv.x * 20.0 + t * 2.0);
    v += u_treble * 0.2 * sin(uv.y * 30.0 - t * 3.0);
    vec3 col = palette(v + f * 0.3);
    col *= 0.8 + u_volume * 0.4 + u_beat * 0.3;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Plasma Storm",
        tags: ["plasma", "storm", "turbulent"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.4;
    float v = fbm(uv * 3.0 + t * 0.3);
    v += fbm(uv * 5.0 - t * 0.5 + v) * u_bass;
    v += sin(length(uv) * 8.0 - t * 2.0 + v * 3.0) * 0.3;
    float f = freq(abs(uv.x));
    vec3 col = palette(v + f * 0.5 + u_time * 0.02);
    col *= 1.0 + u_beat * 0.6 + u_mid * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Liquid Metal",
        tags: ["plasma", "liquid", "metal"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec2 p = uv * 4.0;
    float v = 0.0;
    for (int i = 0; i < 4; i++) {
        p += sin(p.yx * 1.5 + t) * 0.5;
        v += sin(p.x + p.y + t) * 0.25;
    }
    v += u_bass * sin(length(uv) * 10.0 - t * 4.0) * 0.5;
    float spec = pow(abs(sin(v * 5.0)), 8.0);
    vec3 col = palette(v * 0.3 + u_time * 0.01) * (0.6 + spec * 0.8);
    col += spec * palette(v + 0.5) * u_treble;
    col *= 1.0 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createPlasmaShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of PLASMA_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-plasma-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Plasma",
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
