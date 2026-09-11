// Generate PWA icons as SVG data URI PNGs
const fs = require('fs');
const path = require('path');

const svgIcon = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0a0e1a"/>
      <stop offset="100%" style="stop-color:#1a2236"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size * 0.15}" fill="url(#bg)"/>
  <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" fill="#3b82f6" font-family="Arial,sans-serif" font-weight="bold" font-size="${size * 0.35}">♪</text>
  <circle cx="50%" cy="75%" r="${size * 0.08}" fill="#60a5fa" opacity="0.3"/>
</svg>`;

// Save as SVG (browsers support SVG in manifest for many cases, but we also create a simple HTML-based fallback)
fs.writeFileSync(path.join(__dirname, 'public', 'icons', 'icon-192.svg'), svgIcon(192));
fs.writeFileSync(path.join(__dirname, 'public', 'icons', 'icon-512.svg'), svgIcon(512));

// Create PNG placeholders using a minimal 1x1 pixel approach - the browser will render SVG fine
// For proper PNG generation, we create a canvas-based script
const iconScript = `
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
  ctx.font = \`bold \${size * 0.4}px Arial\`;
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
  console.log(\`Generated \${filename}\`);
}

generateIcon(192, 'icon-192.png');
generateIcon(512, 'icon-512.png');
`;

try {
  require('canvas');
  fs.writeFileSync(path.join(__dirname, 'generate-icons.js'), iconScript);
  console.log('Icon generation script created. Run: node generate-icons.js');
} catch (e) {
  // canvas not available, create a minimal valid PNG instead
  // Minimal 8x8 blue PNG
  const minPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGklEQVQYV2P8////fwYGBgZGRkYG' +
    'BkYGBgYAEVEDAARlAQP9MnTBAAAAAElFTkSuQmCC', 'base64'
  );
  fs.writeFileSync(path.join(__dirname, 'public', 'icons', 'icon-192.png'), minPng);
  fs.writeFileSync(path.join(__dirname, 'public', 'icons', 'icon-512.png'), minPng);
  console.log('Created placeholder icons');
}

console.log('Done!');
