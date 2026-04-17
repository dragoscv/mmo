// Generate PNG icon from SVG for electron-builder
// Run: node scripts/generate-icons.mjs

import { writeFileSync, readFileSync } from "fs";
import { createCanvas, loadImage } from "canvas";

// Since we can't easily convert SVG to PNG without heavy dependencies,
// we'll generate a simple purple icon directly with Canvas
// But actually, electron-builder supports icon.png directly

// For simplicity, create a minimal 256x256 PNG programmatically
const size = 256;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext("2d");

// Background - rounded rect with gradient
const gradient = ctx.createLinearGradient(0, 0, size, size);
gradient.addColorStop(0, "#7c3aed");
gradient.addColorStop(1, "#a855f7");

// Draw rounded rect
const radius = 48;
ctx.beginPath();
ctx.moveTo(radius, 0);
ctx.lineTo(size - radius, 0);
ctx.quadraticCurveTo(size, 0, size, radius);
ctx.lineTo(size, size - radius);
ctx.quadraticCurveTo(size, size, size - radius, size);
ctx.lineTo(radius, size);
ctx.quadraticCurveTo(0, size, 0, size - radius);
ctx.lineTo(0, radius);
ctx.quadraticCurveTo(0, 0, radius, 0);
ctx.closePath();
ctx.fillStyle = gradient;
ctx.fill();

// Draw "M" letter
ctx.fillStyle = "white";
ctx.font = "bold 140px -apple-system, Arial, sans-serif";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("M", size / 2, size / 2 + 4);

// Save
writeFileSync("assets/icon.png", canvas.toBuffer("image/png"));
console.log("Generated assets/icon.png");
