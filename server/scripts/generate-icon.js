// Generate a 256x256 icon.png for electron-builder
// Run: node scripts/generate-icon.js

const { createCanvas } = require("canvas");
const { writeFileSync } = require("fs");
const { join } = require("path");

const size = 256;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext("2d");

// Purple gradient background
const gradient = ctx.createLinearGradient(0, 0, size, size);
gradient.addColorStop(0, "#7c3aed");
gradient.addColorStop(1, "#a855f7");

// Rounded rectangle
const r = 48;
ctx.beginPath();
ctx.moveTo(r, 0);
ctx.lineTo(size - r, 0);
ctx.quadraticCurveTo(size, 0, size, r);
ctx.lineTo(size, size - r);
ctx.quadraticCurveTo(size, size, size - r, size);
ctx.lineTo(r, size);
ctx.quadraticCurveTo(0, size, 0, size - r);
ctx.lineTo(0, r);
ctx.quadraticCurveTo(0, 0, r, 0);
ctx.closePath();
ctx.fillStyle = gradient;
ctx.fill();

// White "M" text
ctx.fillStyle = "white";
ctx.font = "bold 140px Arial, sans-serif";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("M", size / 2, size / 2 + 6);

const out = join(__dirname, "..", "assets", "icon.png");
writeFileSync(out, canvas.toBuffer("image/png"));
console.log("Created:", out);
