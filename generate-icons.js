
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function generateIcon(size, filename) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#0a0e1a');
  grad.addColorStop(1, '#1a2236');
  ctx.fillStyle = grad;

  // Rounded rect
  const r = size * 0.15;
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
  ctx.fill();

  // Music note
  ctx.fillStyle = '#3b82f6';
  ctx.font = `bold ${size * 0.4}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('♪', size / 2, size * 0.45);

  // Glow circle
  ctx.beginPath();
  ctx.arc(size / 2, size * 0.72, size * 0.08, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(96, 165, 250, 0.3)';
  ctx.fill();

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(__dirname, 'public', 'icons', filename), buffer);
  console.log(`Generated ${filename}`);
}

generateIcon(192, 'icon-192.png');
generateIcon(512, 'icon-512.png');
