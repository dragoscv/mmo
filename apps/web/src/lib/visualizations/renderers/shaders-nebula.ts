import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const NEBULA_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Cosmic Nebula",
        tags: ["nebula", "cosmic", "space"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.15;
    vec2 p = uv * 2.0;
    float v = fbm(p + t);
    v += fbm(p * 2.0 + v + t * 0.5) * 0.5;
    v += fbm(p * 4.0 + v * 0.5) * 0.25;
    v += u_bass * 0.4 * sin(length(uv) * 5.0 - u_time);
    float stars = pow(hash(floor(uv * 200.0)), 20.0) * (0.5 + u_treble);
    vec3 col = palette(v * 0.5 + u_time * 0.01) * v;
    col += stars;
    col *= 1.0 + u_beat * 0.3;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Stellar Nursery",
        tags: ["nebula", "stellar", "birth"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.1;
    float v = 0.0;
    vec2 p = uv * 3.0;
    for (int i = 0; i < 3; i++) {
        p += sin(p.yx * 1.3 + t) * 0.7;
        v += 1.0 / (1.0 + abs(sin(p.x + p.y)));
    }
    v *= 0.33;
    v += u_bass * fbm(uv * 5.0 + t) * 0.5;
    float glow = exp(-length(uv) * 1.5) * u_volume * 2.0;
    vec3 col = palette(v + t * 0.1) * v + glow * palette(v + 0.3);
    col *= 1.0 + u_beat * 0.5;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Dark Matter",
        tags: ["nebula", "dark", "void"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.2;
    vec2 p = uv * 2.5;
    float d = length(uv);
    float v = 0.0;
    for (int i = 0; i < 5; i++) {
        p = abs(p) / dot(p,p) - 0.8;
        v += exp(-length(p) * 2.0);
        p *= rot2(t * 0.1 + u_mid * 0.3);
    }
    v *= 0.2;
    float ring = abs(sin(d * 8.0 - t * 2.0 + u_bass * 5.0)) * exp(-d * 2.0);
    vec3 col = palette(v + d) * v + palette(d + t * 0.05) * ring;
    col *= 1.0 + u_beat * 0.6;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createNebulaShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of NEBULA_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-nebula-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Nebula",
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
