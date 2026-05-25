// generate_icons.js — Renders icons/icon.svg to all required Chrome extension PNG sizes.
// Run: npm install  (first time only)  then  node generate_icons.js

const sharp = require('sharp');
const fs    = require('fs');
const path  = require('path');

const ICONS_DIR = path.join(__dirname, 'icons');
const SVG_PATH  = path.join(ICONS_DIR, 'icon.svg');
const SIZES     = [16, 32, 48, 128];

async function generateIcons() {
  if (!fs.existsSync(SVG_PATH)) {
    console.error('Error: icons/icon.svg not found. Create the SVG file first.');
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(SVG_PATH);
  console.log('Generating PNG icons from icons/icon.svg...\n');

  for (const size of SIZES) {
    const outputPath = path.join(ICONS_DIR, `icon${size}.png`);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`  ✓  icon${size}.png`);
  }

  console.log('\nAll icons generated successfully.');
}

generateIcons().catch(err => {
  console.error('\nIcon generation failed:', err.message);
  process.exit(1);
});
