import type { VisualizationDef } from "../types";
import { buildShader, SHADER_PALETTES } from "../shader-utils";

const noopRender = () => { };

const COSMIC_SHADERS: { name: string; body: string; tags: string[] }[] = [
    {
        name: "Starfield",
        tags: ["cosmic", "stars", "space"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float t = u_time * 0.3;
    vec3 col = vec3(0.0);
    for (int layer = 0; layer < 4; layer++) {
        float fl = float(layer);
        float scale = 10.0 + fl * 5.0;
        float speed = 0.5 + fl * 0.3;
        vec2 p = uv * scale;
        p.y += t * speed * (1.0 + u_bass);
        vec2 id = floor(p);
        vec2 f2 = fract(p) - 0.5;
        float bright = pow(hash(id), 15.0 + fl * 5.0);
        float twinkle = sin(hash(id + 50.0) * TAU + t * 5.0) * 0.3 + 0.7;
        float star = bright * twinkle * smoothstep(0.3 - fl * 0.05, 0.0, length(f2));
        col += palette(hash(id + 100.0) + t * 0.01) * star * (1.0 + u_treble);
    }
    // Milky way glow
    float mw = exp(-abs(uv.x) * 3.0) * 0.15 * u_volume;
    col += palette(0.6 + t * 0.01) * mw;
    col *= 1.0 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Galaxy Spiral",
        tags: ["cosmic", "galaxy", "spiral"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float a = atan(uv.y, uv.x);
    float r = length(uv);
    float t = u_time * 0.2;
    float arms = 2.0;
    float spiral = sin(a * arms - r * 8.0 + t * 2.0) * 0.5 + 0.5;
    spiral *= exp(-r * 2.0);
    float n = fbm(vec2(a * 2.0 + r * 3.0, r * 5.0 - t));
    spiral += n * 0.3 * exp(-r * 1.5);
    float core = exp(-r * 8.0) * 1.5;
    float f = freq(r * 0.5);
    vec3 col = palette(a / TAU + r * 0.5 + t * 0.03) * spiral;
    col += palette(0.1) * core;
    col *= 1.0 + f * 0.8 + u_bass * 0.5;
    col *= 1.0 + u_beat * 0.4;
    gl_FragColor = vec4(col, 1.0);
`,
    },
    {
        name: "Supernova",
        tags: ["cosmic", "supernova", "explosion"],
        body: `
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float t = u_time * 0.3;
    // Expanding shell
    float shell_r = fract(t * 0.2) * 1.5;
    float shell = exp(-abs(r - shell_r) * 20.0) * (1.0 - fract(t * 0.2));
    // Shockwave
    float wave = sin(r * 20.0 - t * 5.0) * exp(-r * 3.0) * u_bass;
    // Core
    float core = exp(-r * (5.0 - u_volume * 3.0)) * 2.0;
    // Rays
    float rays = pow(abs(sin(a * 8.0 + t)), 8.0) * exp(-r * 2.0) * u_treble;
    float v = shell + wave + core + rays;
    vec3 col = palette(v * 0.5 + r * 0.3 + t * 0.02) * v;
    col *= 1.0 + u_beat * 0.7;
    gl_FragColor = vec4(col, 1.0);
`,
    },
];

export function createCosmicShaderVisualizations(): VisualizationDef[] {
    const results: VisualizationDef[] = [];
    for (const shader of COSMIC_SHADERS) {
        for (const pal of SHADER_PALETTES) {
            results.push({
                id: `shader-cosmic-${shader.name.toLowerCase().replace(/\s+/g, "-")}-${pal.name.toLowerCase()}`,
                name: `${shader.name} (${pal.name})`,
                category: "Shader: Cosmic",
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
