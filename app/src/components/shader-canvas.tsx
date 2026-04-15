"use client";

import { useRef, useEffect, useCallback, useState } from "react";
import { usePlayer } from "./player-context";
import { useAudioAnalyzer } from "@/lib/audio-analyzer";
import type { VisualizationDef } from "@/lib/visualizations/types";
import { AlertTriangle, Loader2 } from "lucide-react";

const VERTEX_SHADER = `
attribute vec2 a_position;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

interface ShaderCanvasProps {
    visualization: VisualizationDef;
    sensitivity?: number;
    quality?: "low" | "medium" | "high";
    className?: string;
    onFpsUpdate?: (fps: number) => void;
}

type ShaderStatus = "compiling" | "ready" | "error";

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn("Shader compile error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl: WebGLRenderingContext, fragSource: string): WebGLProgram | null {
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
    if (!vs || !fs) {
        if (vs) gl.deleteShader(vs);
        if (fs) gl.deleteShader(fs);
        return null;
    }
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // Shaders can be deleted after linking — they stay attached to the program
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.warn("Program link error:", gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

export function ShaderCanvas({
    visualization,
    sensitivity = 1,
    quality = "medium",
    className = "",
    onFpsUpdate,
}: ShaderCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const glRef = useRef<WebGLRenderingContext | null>(null);
    const programRef = useRef<WebGLProgram | null>(null);
    const rafRef = useRef<number>(0);
    const startTimeRef = useRef(0);
    const fpsFramesRef = useRef(0);
    const fpsTimeRef = useRef(0);
    const mouseRef = useRef({ x: 0.5, y: 0.5, active: false });
    const beatAccRef = useRef(0);
    const posBufferRef = useRef<WebGLBuffer | null>(null);
    const freqTexRef = useRef<WebGLTexture | null>(null);
    const contextLostRef = useRef(false);
    const [status, setStatus] = useState<ShaderStatus>("compiling");
    const [errorMsg, setErrorMsg] = useState("");

    const player = usePlayer();
    const { getAudioData } = useAudioAnalyzer();
    const playerRef = useRef(player);
    playerRef.current = player;
    const getAudioDataRef = useRef(getAudioData);
    getAudioDataRef.current = getAudioData;
    const onFpsUpdateRef = useRef(onFpsUpdate);
    onFpsUpdateRef.current = onFpsUpdate;
    const sensitivityRef = useRef(sensitivity);
    sensitivityRef.current = sensitivity;
    const qualityRef = useRef(quality);
    qualityRef.current = quality;

    const handleMouseMove = useCallback((e: MouseEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        mouseRef.current = {
            x: (e.clientX - rect.left) / rect.width,
            y: (e.clientY - rect.top) / rect.height,
            active: true,
        };
    }, []);

    const handleMouseLeave = useCallback(() => {
        mouseRef.current.active = false;
    }, []);

    // Initialize WebGL context ONCE
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        canvas.addEventListener("mousemove", handleMouseMove);
        canvas.addEventListener("mouseleave", handleMouseLeave);

        const handleContextLost = (e: Event) => {
            e.preventDefault();
            contextLostRef.current = true;
            cancelAnimationFrame(rafRef.current);
            setStatus("error");
            setErrorMsg("WebGL context lost — try switching visualization");
        };
        const handleContextRestored = () => {
            contextLostRef.current = false;
            // Re-init will happen via the visualization effect
        };
        canvas.addEventListener("webglcontextlost", handleContextLost);
        canvas.addEventListener("webglcontextrestored", handleContextRestored);

        const gl = canvas.getContext("webgl", {
            alpha: false,
            antialias: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
        });

        if (!gl) {
            setStatus("error");
            setErrorMsg("WebGL not available");
            return () => {
                canvas.removeEventListener("mousemove", handleMouseMove);
                canvas.removeEventListener("mouseleave", handleMouseLeave);
                canvas.removeEventListener("webglcontextlost", handleContextLost);
                canvas.removeEventListener("webglcontextrestored", handleContextRestored);
            };
        }

        glRef.current = gl;

        // Fullscreen quad — created once, reused across shader switches
        const posBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        posBufferRef.current = posBuffer;

        // Frequency texture — created once
        const freqTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, freqTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        freqTexRef.current = freqTex;

        return () => {
            cancelAnimationFrame(rafRef.current);
            canvas.removeEventListener("mousemove", handleMouseMove);
            canvas.removeEventListener("mouseleave", handleMouseLeave);
            canvas.removeEventListener("webglcontextlost", handleContextLost);
            canvas.removeEventListener("webglcontextrestored", handleContextRestored);
            if (programRef.current) gl.deleteProgram(programRef.current);
            if (freqTexRef.current) gl.deleteTexture(freqTexRef.current);
            if (posBufferRef.current) gl.deleteBuffer(posBufferRef.current);
            glRef.current = null;
            // Explicitly lose context to free GPU resources
            const ext = gl.getExtension("WEBGL_lose_context");
            if (ext) ext.loseContext();
        };
    }, [handleMouseMove, handleMouseLeave]);

    // Compile shader & start render loop when visualization changes
    useEffect(() => {
        const gl = glRef.current;
        const canvas = canvasRef.current;
        if (!gl || !canvas || !visualization.shader || contextLostRef.current) return;

        // Stop previous render loop
        cancelAnimationFrame(rafRef.current);

        // Delete old program
        if (programRef.current) {
            gl.deleteProgram(programRef.current);
            programRef.current = null;
        }

        setStatus("compiling");
        setErrorMsg("");

        const program = createProgram(gl, visualization.shader.fragment);
        if (!program) {
            setStatus("error");
            setErrorMsg("Shader compilation failed");
            return;
        }

        programRef.current = program;
        gl.useProgram(program);

        // Re-bind vertex attribute
        gl.bindBuffer(gl.ARRAY_BUFFER, posBufferRef.current);
        const aPos = gl.getAttribLocation(program, "a_position");
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        // Bind frequency texture to unit 0
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, freqTexRef.current);
        const uFreq = gl.getUniformLocation(program, "u_frequency");
        if (uFreq !== null) gl.uniform1i(uFreq, 0);

        // Upload palette colors
        const shader = visualization.shader;
        if (shader.palette) {
            for (let i = 0; i < Math.min(shader.palette.length, 6); i++) {
                const loc = gl.getUniformLocation(program, `u_color${i}`);
                if (loc) gl.uniform3fv(loc, shader.palette[i]);
            }
            const uColors = gl.getUniformLocation(program, "u_colorCount");
            if (uColors) gl.uniform1i(uColors, shader.palette.length);
        }

        // Cache uniform locations
        const uTime = gl.getUniformLocation(program, "u_time");
        const uResolution = gl.getUniformLocation(program, "u_resolution");
        const uBass = gl.getUniformLocation(program, "u_bass");
        const uMid = gl.getUniformLocation(program, "u_mid");
        const uTreble = gl.getUniformLocation(program, "u_treble");
        const uVolume = gl.getUniformLocation(program, "u_volume");
        const uBeat = gl.getUniformLocation(program, "u_beat");
        const uBeatAcc = gl.getUniformLocation(program, "u_beatAcc");
        const uMouse = gl.getUniformLocation(program, "u_mouse");
        const uSensitivity = gl.getUniformLocation(program, "u_sensitivity");

        setStatus("ready");
        startTimeRef.current = performance.now();
        fpsTimeRef.current = performance.now();
        fpsFramesRef.current = 0;
        beatAccRef.current = 0;

        const freqData = new Uint8Array(256);

        const render = () => {
            if (gl.isContextLost()) return;

            const now = performance.now();
            const time = (now - startTimeRef.current) / 1000;

            // FPS
            fpsFramesRef.current++;
            if (now - fpsTimeRef.current >= 1000) {
                onFpsUpdateRef.current?.(fpsFramesRef.current);
                fpsFramesRef.current = 0;
                fpsTimeRef.current = now;
            }

            // Resize
            const q = qualityRef.current;
            const dpr = q === "low" ? 0.5 : q === "high" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
            const rect = canvas.getBoundingClientRect();
            const w = Math.floor(rect.width * dpr);
            const h = Math.floor(rect.height * dpr);
            if (w < 1 || h < 1) {
                rafRef.current = requestAnimationFrame(render);
                return;
            }
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            gl.viewport(0, 0, w, h);

            // Audio
            const analyser = playerRef.current.getAnalyserNode();
            const audioData = getAudioDataRef.current(analyser);
            const sens = sensitivityRef.current;

            if (audioData.beat) beatAccRef.current += 1;
            beatAccRef.current *= 0.98;

            // Upload frequency texture
            for (let i = 0; i < 256; i++) {
                freqData[i] = i < audioData.frequency.length ? audioData.frequency[i] : 0;
            }
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, freqTexRef.current);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 256, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, freqData);

            // Uniforms
            if (uTime !== null) gl.uniform1f(uTime, time);
            if (uResolution !== null) gl.uniform2f(uResolution, rect.width, rect.height);
            if (uBass !== null) gl.uniform1f(uBass, audioData.bass * sens);
            if (uMid !== null) gl.uniform1f(uMid, audioData.mid * sens);
            if (uTreble !== null) gl.uniform1f(uTreble, audioData.treble * sens);
            if (uVolume !== null) gl.uniform1f(uVolume, audioData.volume * sens);
            if (uBeat !== null) gl.uniform1f(uBeat, audioData.beat ? 1.0 : 0.0);
            if (uBeatAcc !== null) gl.uniform1f(uBeatAcc, beatAccRef.current);
            if (uMouse !== null) gl.uniform2f(uMouse, mouseRef.current.x, mouseRef.current.y);
            if (uSensitivity !== null) gl.uniform1f(uSensitivity, sens);

            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            rafRef.current = requestAnimationFrame(render);
        };

        rafRef.current = requestAnimationFrame(render);

        return () => {
            cancelAnimationFrame(rafRef.current);
        };
    }, [visualization]);

    return (
        <div className={className} style={{ position: "relative", background: "#000" }}>
            <canvas
                ref={canvasRef}
                style={{ width: "100%", height: "100%", display: "block" }}
            />
            {status === "compiling" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                    <div className="flex items-center gap-2 text-sm text-white/60">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Compiling shader…
                    </div>
                </div>
            )}
            {status === "error" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/90">
                    <div className="flex flex-col items-center gap-2 text-sm text-white/60">
                        <AlertTriangle className="h-5 w-5 text-yellow-500" />
                        <span>{errorMsg || "Shader failed to load"}</span>
                        <span className="text-xs text-white/30">Try a different visualization</span>
                    </div>
                </div>
            )}
        </div>
    );
}
