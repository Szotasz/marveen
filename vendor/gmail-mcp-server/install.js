#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Setting up Gmail MCP Server...');

// Make CLI executable
const binPath = path.join(__dirname, 'bin', 'cli.js');
if (fs.existsSync(binPath)) {
  try {
    fs.chmodSync(binPath, '755');
    console.log('✓ Made CLI executable');
  } catch (error) {
    console.warn('Warning: Could not make CLI executable:', error.message);
  }
} else {
  console.warn('Warning: CLI file not found at', binPath);
}

// Display setup message
console.log(`
✓ Gmail MCP Server installed successfully!

Quick Start:
1. Get OAuth2 credentials from Google Cloud Console
2. Start server: npx gmail-mcp-server@latest --client-id "your-id" --client-secret "your-secret"
3. Use authentication tools when needed

🔐 On-Demand Authentication - Server starts immediately!

For help: npx gmail-mcp-server@latest --help
Documentation: Check README.md for complete setup guide
`); 