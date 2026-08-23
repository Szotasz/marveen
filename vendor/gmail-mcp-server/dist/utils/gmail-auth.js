import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import open from 'open';
import { createServer } from 'http';
import { URL } from 'url';
import { logger } from './api.js';
// Scopes required for Gmail operations
const SCOPES = [
    'profile',
    'email',
    'openid',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.labels'
];
// Configuration directory and file paths
const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');
const TOKEN_FILE = path.join(CONFIG_DIR, 'token.json');
/**
 * Gmail authentication manager class
 */
export class GmailAuth {
    constructor() {
        this.oAuth2Client = null;
        this.credentials = null;
        this.activeServer = null;
        this.activeServerPort = null;
        this.activeServerTimeout = null;
        this.ensureConfigDir();
    }
    /**
     * Ensure configuration directory exists
     */
    ensureConfigDir() {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
            logger.log('Created Gmail MCP configuration directory');
        }
    }
    /**
     * Load credentials from file or environment
     */
    async loadCredentials() {
        try {
            // Try environment variables first
            if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET) {
                this.credentials = {
                    client_id: process.env.GMAIL_CLIENT_ID,
                    client_secret: process.env.GMAIL_CLIENT_SECRET,
                    redirect_uris: [process.env.GMAIL_REDIRECT_URI || 'http://localhost:44000/oauth2callback']
                };
                logger.log('Loaded Gmail credentials from environment variables');
                return true;
            }
            // Try credentials file
            if (fs.existsSync(CREDENTIALS_FILE)) {
                const credentialsData = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
                const parsedCredentials = JSON.parse(credentialsData);
                // Handle both desktop and web app credential formats
                if (parsedCredentials.installed) {
                    this.credentials = parsedCredentials.installed;
                }
                else if (parsedCredentials.web) {
                    this.credentials = parsedCredentials.web;
                }
                else {
                    this.credentials = parsedCredentials;
                }
                logger.log('Loaded Gmail credentials from file');
                return true;
            }
            return false;
        }
        catch (error) {
            logger.error('Error loading Gmail credentials:', error);
            return false;
        }
    }
    /**
     * Save credentials to file
     */
    async saveCredentials(credentials) {
        try {
            fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
            logger.log('Saved Gmail credentials to file');
        }
        catch (error) {
            logger.error('Error saving Gmail credentials:', error);
            throw new Error('Failed to save credentials');
        }
    }
    /**
     * Initialize OAuth2 client
     */
    initializeOAuth2Client() {
        if (!this.credentials) {
            throw new Error('Credentials not loaded');
        }
        this.oAuth2Client = new google.auth.OAuth2(this.credentials.client_id, this.credentials.client_secret, this.credentials.redirect_uris?.[0] || 'http://localhost:44000/oauth2callback');
        return this.oAuth2Client;
    }
    /**
     * Load stored access token
     */
    loadStoredToken() {
        try {
            if (fs.existsSync(TOKEN_FILE)) {
                const tokenData = fs.readFileSync(TOKEN_FILE, 'utf8');
                return JSON.parse(tokenData);
            }
        }
        catch (error) {
            logger.error('Error loading stored token:', error);
        }
        return null;
    }
    /**
     * Save access token to file
     */
    saveToken(token) {
        try {
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
            logger.log('Saved Gmail access token');
        }
        catch (error) {
            logger.error('Error saving token:', error);
        }
    }
    /**
     * Find an available port starting from a base port
     */
    async findAvailablePort(basePort) {
        const net = await import('net');
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            server.listen(basePort, () => {
                const port = server.address()?.port;
                server.close(() => {
                    resolve(port);
                });
            });
            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    // Try next port
                    this.findAvailablePort(basePort + 1).then(resolve).catch(reject);
                }
                else {
                    reject(err);
                }
            });
        });
    }
    /**
     * Stop any active callback server
     */
    stopActiveServer() {
        if (this.activeServer) {
            try {
                this.activeServer.close();
                logger.log(`Stopped callback server on port ${this.activeServerPort}`);
            }
            catch (error) {
                logger.error('Error stopping active server:', error);
            }
            this.activeServer = null;
            this.activeServerPort = null;
        }
        if (this.activeServerTimeout) {
            clearTimeout(this.activeServerTimeout);
            this.activeServerTimeout = null;
        }
    }
    /**
     * Start local server for OAuth2 callback
     */
    async startCallbackServer(timeoutMs = 600000) {
        // Stop any existing server first
        this.stopActiveServer();
        // Extract port from redirect URI or use default
        const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:44000/oauth2callback';
        const url = new URL(redirectUri);
        const preferredPort = parseInt(url.port) || 44000;
        const callbackPath = url.pathname || '/oauth2callback';
        // Find an available port starting from preferred port
        const availablePort = await this.findAvailablePort(preferredPort);
        return new Promise((resolve, reject) => {
            // Set up timeout
            this.activeServerTimeout = setTimeout(() => {
                this.stopActiveServer();
                reject(new Error(`Authentication timeout after ${timeoutMs / 1000} seconds. Please try again.`));
            }, timeoutMs);
            this.activeServer = createServer((req, res) => {
                if (req.url?.startsWith(callbackPath)) {
                    const reqUrl = new URL(req.url, `http://localhost:${availablePort}`);
                    const code = reqUrl.searchParams.get('code');
                    const error = reqUrl.searchParams.get('error');
                    if (error) {
                        res.end(`<html><body><h1>Authentication Error</h1><p>${error}</p></body></html>`);
                        this.stopActiveServer();
                        reject(new Error(`OAuth2 error: ${error}`));
                        return;
                    }
                    if (code) {
                        res.end(`<html><body><h1>Authentication Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>`);
                        this.stopActiveServer();
                        resolve({ code, port: availablePort });
                        return;
                    }
                    res.end('<html><body><h1>Invalid Request</h1></body></html>');
                }
                else {
                    res.end('<html><body><h1>Gmail MCP Server OAuth2</h1><p>Waiting for authentication...</p></body></html>');
                }
            });
            this.activeServer.listen(availablePort, (err) => {
                if (err) {
                    this.stopActiveServer();
                    reject(new Error(`Failed to start callback server on port ${availablePort}: ${err.message}`));
                    return;
                }
                this.activeServerPort = availablePort;
                logger.log(`OAuth2 callback server started on port ${availablePort} (path: ${callbackPath})`);
            });
            this.activeServer.on('error', (err) => {
                this.stopActiveServer();
                reject(new Error(`Callback server error: ${err.message}`));
            });
        });
    }
    /**
     * Perform OAuth2 authentication flow
     */
    async authenticate() {
        if (!await this.loadCredentials()) {
            throw new Error('Gmail credentials not found. Please run with --setup-auth flag first.');
        }
        // Always create fresh OAuth2Client to handle different accounts
        const auth = this.initializeOAuth2Client();
        // Try to load existing token
        const storedToken = this.loadStoredToken();
        if (storedToken) {
            auth.setCredentials(storedToken);
            // Check if token is still valid
            try {
                await auth.getAccessToken();
                logger.log('Using existing valid token');
                this.oAuth2Client = auth; // Update cached client
                return auth;
            }
            catch (error) {
                logger.log('Access token invalid, attempting refresh...');
                // Try to refresh the token if we have a refresh token
                if (storedToken.refresh_token) {
                    try {
                        const refreshResponse = await auth.refreshAccessToken();
                        const newTokens = refreshResponse.credentials;
                        // Update stored token with new access token and expiry
                        const updatedToken = {
                            ...storedToken,
                            access_token: newTokens.access_token || storedToken.access_token,
                            expiry_date: newTokens.expiry_date || storedToken.expiry_date
                        };
                        // Save the updated tokens
                        this.saveToken(updatedToken);
                        // Set the new credentials
                        auth.setCredentials(updatedToken);
                        logger.log('Successfully refreshed access token');
                        this.oAuth2Client = auth; // Update cached client
                        return auth;
                    }
                    catch (refreshError) {
                        logger.error('Failed to refresh token:', refreshError);
                        logger.log('Refresh token invalid, requesting new authentication');
                        // Fall through to full re-authentication
                    }
                }
                else {
                    logger.log('No refresh token available, requesting new authentication');
                    // Fall through to full re-authentication
                }
            }
        }
        // Generate authentication URL
        const authUrl = auth.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            state: process.env.USER_ID || 'localhost',
            prompt: 'consent'
        });
        logger.log('Starting OAuth2 authentication flow');
        console.error('\nStarting Gmail authentication...');
        console.error('If browser doesn\'t open automatically, visit this URL:');
        console.error(authUrl);
        try {
            // Start callback server and open browser
            const serverPromise = this.startCallbackServer();
            // Update auth URL to use the actual port if different from preferred
            const result = await serverPromise;
            const actualPort = result.port;
            // If the actual port is different from the one in the auth URL, we need to update the redirect URI
            if (actualPort !== (parseInt(new URL(process.env.GMAIL_REDIRECT_URI || 'http://localhost:44000/oauth2callback').port) || 44000)) {
                // Update OAuth2 client with correct redirect URI
                const redirectUri = process.env.GMAIL_REDIRECT_URI || 'http://localhost:44000/oauth2callback';
                const url = new URL(redirectUri);
                url.port = actualPort.toString();
                this.oAuth2Client = new google.auth.OAuth2(this.credentials.client_id, this.credentials.client_secret, url.toString());
                // Regenerate auth URL with correct port
                const updatedAuthUrl = this.oAuth2Client.generateAuthUrl({
                    access_type: 'offline',
                    scope: SCOPES,
                    state: process.env.USER_ID || 'localhost',
                    prompt: 'consent'
                });
                await open(updatedAuthUrl);
                logger.log(`Updated auth URL for port ${actualPort}`);
            }
            else {
                await open(authUrl);
            }
            const code = result.code;
            // Exchange code for tokens
            const { tokens } = await auth.getToken(code);
            auth.setCredentials(tokens);
            // Save tokens for future use
            this.saveToken(tokens);
            logger.log('Gmail authentication completed successfully');
            console.error('Authentication successful!\n');
            this.oAuth2Client = auth; // Cache the new authenticated client
            return auth;
        }
        catch (error) {
            logger.error('Authentication failed:', error);
            throw new Error(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Get authenticated Gmail API client
     */
    async getGmailClient() {
        // Check if we have an existing authenticated client
        if (this.oAuth2Client) {
            try {
                // Try to get a fresh access token (this will auto-refresh if needed)
                await this.oAuth2Client.getAccessToken();
                return google.gmail({ version: 'v1', auth: this.oAuth2Client });
            }
            catch (error) {
                logger.log('Cached client token invalid, re-authenticating...');
                // Clear the cached client and fall through to re-authentication
                this.oAuth2Client = null;
            }
        }
        // No cached client or cached client failed, authenticate
        const auth = await this.authenticate();
        return google.gmail({ version: 'v1', auth });
    }
    /**
     * Prompt user for credentials setup
     */
    async setupCredentials() {
        console.log('\n=== Gmail MCP Server Setup ===');
        console.log('To use this server, you need to set up Google API credentials.');
        console.log('\nPlease follow these steps:');
        console.log('1. Go to https://console.developers.google.com/');
        console.log('2. Create a new project or select existing project');
        console.log('3. Enable the Gmail API');
        console.log('4. Create credentials (OAuth 2.0 Client ID)');
        console.log('5. Set redirect URI to: http://localhost:44000/oauth2callback (or your custom URI)');
        console.log('6. Download the credentials JSON file');
        console.log(`7. Save it as: ${CREDENTIALS_FILE}`);
        console.log('\nAlternatively, set environment variables:');
        console.log('- GMAIL_CLIENT_ID');
        console.log('- GMAIL_CLIENT_SECRET');
        console.log('- GMAIL_REDIRECT_URI (optional, defaults to http://localhost:44000/oauth2callback)');
        console.log('- USER_ID (optional, for OAuth state validation, defaults to user id)');
        console.log('\n📝 GMAIL_REDIRECT_URI Examples:');
        console.log('export GMAIL_REDIRECT_URI="http://localhost:8080/auth/callback"');
        console.log('export GMAIL_REDIRECT_URI="https://yourdomain.com/oauth2callback"');
        console.log('export GMAIL_REDIRECT_URI="http://127.0.0.1:3000/callback"');
        console.log('\nFor cloud deployments:');
        console.log('- Set GMAIL_REDIRECT_URI to your server\'s callback endpoint');
        console.log('- The callback server will automatically use the port from GMAIL_REDIRECT_URI');
        console.log('- USER_ID is often automatically set by cloud platforms');
        console.log('\nFor detailed instructions, visit: https://developers.google.com/gmail/api/quickstart/nodejs');
    }
    /**
     * Check if user credentials are configured
     */
    async isConfigured() {
        // Check environment variables first
        if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET) {
            return true;
        }
        // Check credentials file
        try {
            fs.accessSync(CREDENTIALS_FILE);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Check if user is currently authenticated (has valid tokens)
     */
    async isAuthenticated() {
        try {
            fs.accessSync(TOKEN_FILE);
            const tokenData = fs.readFileSync(TOKEN_FILE, 'utf8');
            const tokens = JSON.parse(tokenData);
            // Check if we have both access and refresh tokens
            if (!tokens.access_token) {
                return false;
            }
            // If we have a refresh token, we can always get a new access token
            if (tokens.refresh_token) {
                return true;
            }
            // Check if access token is still valid (not expired)
            if (tokens.expiry_date && tokens.expiry_date > Date.now()) {
                return true;
            }
            return false;
        }
        catch {
            return false;
        }
    }
    /**
     * Reset authentication (clear stored tokens)
     */
    resetAuth() {
        try {
            if (fs.existsSync(TOKEN_FILE)) {
                fs.unlinkSync(TOKEN_FILE);
                logger.log('Cleared stored authentication tokens');
            }
            // Stop any active callback server
            this.stopActiveServer();
            // Reset cached OAuth2Client
            this.resetClient();
        }
        catch (error) {
            logger.error('Error clearing tokens:', error);
        }
    }
    /**
     * Get authentication URL without starting the full authentication flow
     * This allows for manual authentication control
     */
    async getAuthUrl() {
        if (!await this.loadCredentials()) {
            throw new Error('Gmail credentials not found. Please configure OAuth2 credentials first.');
        }
        const auth = this.initializeOAuth2Client();
        // Start callback server with shorter timeout for manual mode
        // This ensures the link works if clicked immediately, but doesn't hang forever
        this.startCallbackServer(180000).then(async (result) => {
            try {
                // Exchange code for tokens
                const { tokens } = await auth.getToken(result.code);
                auth.setCredentials(tokens);
                // Save tokens for future use
                this.saveToken(tokens);
                // Cache the new authenticated client
                this.oAuth2Client = auth;
                logger.log('Gmail authentication completed successfully via manual link');
            }
            catch (error) {
                logger.error('Authentication failed via manual link:', error);
            }
        }).catch((error) => {
            logger.log(`Manual authentication callback server timeout or error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        });
        // Generate authentication URL
        const authUrl = auth.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            state: process.env.USER_ID || 'localhost',
            prompt: 'consent'
        });
        logger.log('Generated Gmail authentication URL for manual mode with 3-minute callback server');
        return authUrl;
    }
    /**
     * Complete manual authentication flow
     * Call this after user has visited the auth URL to finalize authentication
     */
    async completeManualAuth() {
        try {
            // Check if we now have valid tokens (from the callback server)
            return await this.isAuthenticated();
        }
        catch (error) {
            logger.error('Error checking authentication status:', error);
            return false;
        }
    }
    /**
     * Reset cached OAuth2Client (called when switching accounts)
     */
    resetClient() {
        this.oAuth2Client = null;
        // Also stop any active servers when resetting client
        this.stopActiveServer();
    }
}
// Export singleton instance
export const gmailAuth = new GmailAuth();
