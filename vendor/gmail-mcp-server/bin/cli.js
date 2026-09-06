#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import fs from 'fs';
import readline from 'readline';
import os from 'os';

// Debug info - write to a debug file
const debugFile = path.join(os.tmpdir(), 'gmail-mcp-debug.log');
const writeDebug = (message) => {
  try {
    fs.appendFileSync(debugFile, `${new Date().toISOString()} - ${message}\n`);
  } catch (err) {
    // Silently fail if we can't write to the debug file
  }
};

// Start debugging
writeDebug('Gmail MCP CLI script started');
writeDebug(`Node version: ${process.version}`);
writeDebug(`Platform: ${process.platform}`);
writeDebug(`CLI Arguments: ${process.argv.join(' ')}`);
writeDebug(`Is stdin a TTY: ${process.stdin.isTTY}`);
writeDebug(`Is stdout a TTY: ${process.stdout.isTTY}`);
writeDebug(`Process PID: ${process.pid}`);
writeDebug(`Executable path: ${process.execPath}`);
writeDebug(`Current directory: ${process.cwd()}`);

// Print debug file location to stderr (not stdout)
console.error(`Debug log: ${debugFile}`);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

writeDebug(`__filename: ${__filename}`);
writeDebug(`__dirname: ${__dirname}`);
writeDebug(`packageRoot: ${packageRoot}`);

// Check if bin/cli.js is executable
try {
  const stats = fs.statSync(__filename);
  const isExecutable = !!(stats.mode & fs.constants.S_IXUSR);
  writeDebug(`Is CLI executable: ${isExecutable}`);
  
  // Make it executable if it's not
  if (!isExecutable) {
    fs.chmodSync(__filename, '755');
    writeDebug('Made CLI executable');
  }
} catch (err) {
  writeDebug(`Error checking/setting executable: ${err.message}`);
}

// Parse command line arguments
const args = process.argv.slice(2);
let debug = false;
let nonInteractive = false;
let setupAuth = false;
let resetAuth = false;

// Detect if we're running under an MCP context (SIYA/Claude/ChatGPT/etc.)
const isMcpContext = 
  !process.stdin.isTTY || 
  process.env.npm_execpath?.includes('npx') ||
  process.env.CLAUDE_API_KEY ||
  args.includes('--non-interactive') || args.includes('-n');

writeDebug(`Detected MCP context: ${isMcpContext}`);
if (isMcpContext) {
  nonInteractive = true;
  writeDebug('Setting non-interactive mode due to MCP context detection');
}

// Process command line arguments
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--debug') {
    debug = true;
    writeDebug('Debug mode enabled');
  } else if (arg === '--non-interactive' || arg === '-n') {
    nonInteractive = true;
    writeDebug('Non-interactive mode enabled via flag');
  } else if (arg === '--setup-auth') {
    setupAuth = true;
    writeDebug('Setup auth mode enabled');
  } else if (arg === '--reset-auth') {
    resetAuth = true;
    writeDebug('Reset auth mode enabled');
  } else if (arg === '--client-id') {
    // Handle --client-id argument
    if (i + 1 < args.length) {
      // Ensure the next argument is not an option
      if (args[i + 1].startsWith('--') || args[i + 1] === '-n') {
        console.error('--client-id must be followed by a client ID');
        process.exit(1);
      }
      // Store the client ID
      process.env.GMAIL_CLIENT_ID = args[i + 1];
      writeDebug(`Client ID set to: ${args[i + 1]}`);
      i++; // Skip the next argument as it's already processed
    } else {
      console.error('--client-id requires a client ID');
      process.exit(1);
    }
  } else if (arg === '--client-secret') {
    // Handle --client-secret argument
    if (i + 1 < args.length) {
      // Ensure the next argument is not an option
      if (args[i + 1].startsWith('--') || args[i + 1] === '-n') {
        console.error('--client-secret must be followed by a client secret');
        process.exit(1);
      }
      // Store the client secret
      process.env.GMAIL_CLIENT_SECRET = args[i + 1];
      writeDebug(`Client secret set to: ${args[i + 1]}`);
      i++; // Skip the next argument as it's already processed
    } else {
      console.error('--client-secret requires a client secret');
      process.exit(1);
    }
  } else if (arg === '--redirect-uri') {
    // Handle --redirect-uri argument
    if (i + 1 < args.length) {
      // Ensure the next argument is not an option
      if (args[i + 1].startsWith('--') || args[i + 1] === '-n') {
        console.error('--redirect-uri must be followed by a redirect URI');
        process.exit(1);
      }
      // Store the redirect URI
      process.env.GMAIL_REDIRECT_URI = args[i + 1];
      writeDebug(`Redirect URI set to: ${args[i + 1]}`);
      i++; // Skip the next argument as it's already processed
    } else {
      console.error('--redirect-uri requires a redirect URI');
      process.exit(1);
    }
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Gmail MCP Server - Gmail Integration for SIYA/Claude Desktop

Usage: npx gmail-mcp-server [options]

Options:
  --setup-auth               Set up Gmail API credentials
  --reset-auth               Clear stored authentication tokens
  --debug                    Enable debug output
  --non-interactive, -n      Run in non-interactive mode (no prompt)
  --client-id <id>           Gmail OAuth2 client ID
  --client-secret <secret>   Gmail OAuth2 client secret
  --redirect-uri <uri>       Gmail OAuth2 redirect URI
  --force-manual-auth        (Legacy option - manual auth is now default)
  --help, -h                 Show this help message

Setup:
  1. Run: npx gmail-mcp-server --setup-auth
  2. Follow the instructions to set up Google API credentials
  3. Run: npx gmail-mcp-server to start the server

Authentication Setup:
  The server supports three methods for providing Gmail API credentials:

  1. Command Line Arguments:
     - --client-id <your_client_id>
     - --client-secret <your_client_secret>
     - --redirect-uri <your_redirect_uri>

  2. Environment Variables:
     - GMAIL_CLIENT_ID: Your OAuth2 client ID
     - GMAIL_CLIENT_SECRET: Your OAuth2 client secret
     - GMAIL_REDIRECT_URI: Your OAuth2 redirect URI (defaults to http://localhost:44000/oauth2callback)
     - GMAIL_FORCE_MANUAL_AUTH: (Legacy - manual authentication is now default for all users)

  3. Credentials File:
     - Download credentials JSON from Google Cloud Console
     - Save as ~/.gmail-mcp/credentials.json

For detailed setup instructions, visit:
https://developers.google.com/gmail/api/quickstart/nodejs

Examples:
  npx gmail-mcp-server --setup-auth    # Set up authentication
  npx gmail-mcp-server                 # Start the server
  npx gmail-mcp-server --reset-auth    # Clear auth tokens
  npx gmail-mcp-server --client-id "your_id" --client-secret "your_secret"
  npx gmail-mcp-server --client-id "your_id" --client-secret "your_secret" --redirect-uri "http://localhost:8080/oauth2callback"
`);
    process.exit(0);
  }
}

function startServer() {
  const serverPath = path.join(packageRoot, 'dist', 'index.js');
  
  // Check if the compiled server exists
  if (!fs.existsSync(serverPath)) {
    console.error('Server not found. Building...');
    
    // Try to build the project
    const buildProcess = spawn('npm', ['run', 'build'], {
      cwd: packageRoot,
      stdio: 'inherit'
    });
    
    buildProcess.on('close', (code) => {
      if (code === 0) {
        startServerWithPath(serverPath);
      } else {
        console.error('Build failed. Please run "npm run build" manually.');
        process.exit(1);
      }
    });
  } else {
    startServerWithPath(serverPath);
  }
}

function startServerWithPath(serverPath) {
  writeDebug(`Starting server with path: ${serverPath}`);
  
  // Prepare arguments for the server
  const serverArgs = [];
  
  if (setupAuth) serverArgs.push('--setup-auth');
  if (resetAuth) serverArgs.push('--reset-auth');
  if (debug) serverArgs.push('--debug');
  if (nonInteractive) serverArgs.push('--non-interactive');
  
  writeDebug(`Server arguments: ${serverArgs.join(' ')}`);
  
  // Log environment variables for debugging
  writeDebug(`GMAIL_CLIENT_ID in process.env: ${process.env.GMAIL_CLIENT_ID || 'not set'}`);
  writeDebug(`GMAIL_CLIENT_SECRET in process.env: ${process.env.GMAIL_CLIENT_SECRET || 'not set'}`);
  writeDebug(`GMAIL_REDIRECT_URI in process.env: ${process.env.GMAIL_REDIRECT_URI || 'not set'}`);
  
  // Start the server process
  const serverProcess = spawn(process.execPath, [serverPath, ...serverArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Ensure environment variables are passed through
      NODE_PATH: process.env.NODE_PATH || '',
    }
  });
  
  // Handle server process events
  serverProcess.on('error', (err) => {
    writeDebug(`Server process error: ${err.message}`);
    console.error('Failed to start Gmail MCP server:', err.message);
    process.exit(1);
  });
  
  serverProcess.on('close', (code, signal) => {
    writeDebug(`Server process closed with code ${code} and signal ${signal}`);
    if (code !== 0) {
      console.error(`Gmail MCP server exited with code ${code}`);
    }
    process.exit(code || 0);
  });
  
  // Handle SIGINT and SIGTERM
  process.on('SIGINT', () => {
    writeDebug('Received SIGINT, terminating server process');
    serverProcess.kill('SIGINT');
  });
  
  process.on('SIGTERM', () => {
    writeDebug('Received SIGTERM, terminating server process');
    serverProcess.kill('SIGTERM');
  });
}

// Special handling for setup and reset modes
if (setupAuth || resetAuth) {
  writeDebug('Running in special mode (setup or reset)');
  startServer();
} else {
  // Normal server startup
  writeDebug('Starting normal server mode');
  startServer();
} 