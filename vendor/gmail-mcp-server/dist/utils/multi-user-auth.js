import { google } from 'googleapis';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createServer } from 'http';
import { URL } from 'url';
import { logger } from './api.js';
import { createHash, randomBytes } from 'crypto';
// Scopes required for Gmail operations
const SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.labels'
];
// Configuration directory
const CONFIG_DIR = path.join(os.homedir(), '.gmail-mcp');
/**
 * Multi-user Gmail authentication manager
 */
export class MultiUserGmailAuth {
    constructor() {
        this.sessions = new Map();
        this.credentials = null;
        this.authServers = new Map();
        this.ensureConfigDir();
        this.loadCredentials();
        this.loadExistingSessions();
    }
    ensureConfigDir() {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
    }
    /**
     * Load credentials from environment or file
     */
    loadCredentials() {
        try {
            // Try environment variables first
            if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET) {
                this.credentials = {
                    client_id: process.env.GMAIL_CLIENT_ID,
                    client_secret: process.env.GMAIL_CLIENT_SECRET,
                    redirect_uris: [process.env.GMAIL_REDIRECT_URI || 'http://localhost:44000/oauth2callback']
                };
                logger.log('Loaded Gmail credentials from environment variables');
                return;
            }
            // Try credentials file
            const credentialsFile = path.join(CONFIG_DIR, 'credentials.json');
            if (fs.existsSync(credentialsFile)) {
                const credentialsData = fs.readFileSync(credentialsFile, 'utf8');
                const parsedCredentials = JSON.parse(credentialsData);
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
            }
        }
        catch (error) {
            logger.error('Error loading Gmail credentials:', error);
        }
    }
    /**
     * Load existing user sessions
     */
    loadExistingSessions() {
        try {
            const sessionsFile = path.join(CONFIG_DIR, 'user-sessions.json');
            if (fs.existsSync(sessionsFile)) {
                const sessionsData = fs.readFileSync(sessionsFile, 'utf8');
                const sessions = JSON.parse(sessionsData);
                for (const [userId, session] of Object.entries(sessions)) {
                    this.sessions.set(userId, session);
                }
                logger.log(`Loaded ${this.sessions.size} existing user sessions`);
            }
        }
        catch (error) {
            logger.error('Error loading existing sessions:', error);
        }
    }
    /**
     * Save user sessions to file
     */
    saveUserSessions() {
        try {
            const sessionsFile = path.join(CONFIG_DIR, 'user-sessions.json');
            const sessionsObj = Object.fromEntries(this.sessions);
            fs.writeFileSync(sessionsFile, JSON.stringify(sessionsObj, null, 2));
            logger.log('Saved user sessions');
        }
        catch (error) {
            logger.error('Error saving user sessions:', error);
        }
    }
    /**
     * Generate a unique user ID
     */
    generateUserId(userEmail) {
        const timestamp = Date.now().toString();
        const random = randomBytes(8).toString('hex');
        if (userEmail) {
            const emailHash = createHash('sha256').update(userEmail).digest('hex').substring(0, 8);
            return `user_${emailHash}_${timestamp.substring(-6)}_${random.substring(0, 4)}`;
        }
        return `user_${timestamp}_${random}`;
    }
    /**
     * Create OAuth2 client for a user
     */
    createOAuth2Client(redirectUri) {
        if (!this.credentials) {
            throw new Error('Gmail credentials not configured');
        }
        return new google.auth.OAuth2(this.credentials.client_id, this.credentials.client_secret, redirectUri || this.credentials.redirect_uris?.[0] || 'http://localhost:44000/oauth2callback');
    }
    /**
     * Start authentication flow for a new user
     */
    async authenticateNewUser(userEmail) {
        if (!this.credentials) {
            throw new Error('Gmail credentials not configured. Please set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables.');
        }
        const userId = this.generateUserId(userEmail);
        // Find available port
        const port = await this.findAvailablePort();
        const redirectUri = `http://localhost:${port}/oauth2callback`;
        // Create OAuth2 client with specific redirect URI
        const auth = this.createOAuth2Client(redirectUri);
        // Generate authentication URL
        const authUrl = auth.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            prompt: 'consent',
            state: `${userId}:${process.env.USER_ID || 'localhost'}` // Include user ID and USER_ID in state for identification
        });
        // Start callback server for this user
        await this.startCallbackServer(userId, auth, port);
        logger.log(`Started authentication flow for user ${userId} on port ${port}`);
        return { userId, authUrl, port };
    }
    /**
     * Find an available port for OAuth callback
     */
    async findAvailablePort(startPort = 44000) {
        return new Promise((resolve) => {
            const server = createServer();
            server.listen(startPort, () => {
                const port = server.address()?.port || startPort;
                server.close(() => resolve(port));
            });
            server.on('error', () => {
                resolve(this.findAvailablePort(startPort + 1));
            });
        });
    }
    /**
     * Start callback server for OAuth2
     */
    async startCallbackServer(userId, auth, port) {
        return new Promise((resolve, reject) => {
            const server = createServer(async (req, res) => {
                if (req.url?.startsWith('/oauth2callback')) {
                    const url = new URL(req.url, `http://localhost:${port}`);
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const error = url.searchParams.get('error');
                    if (error) {
                        res.end(`<html><body><h1>Authentication Error</h1><p>${error}</p></body></html>`);
                        server.close();
                        this.authServers.delete(userId);
                        reject(new Error(`OAuth2 error: ${error}`));
                        return;
                    }
                    if (code && state && state.startsWith(`${userId}:`)) {
                        try {
                            // Exchange code for tokens
                            const { tokens } = await auth.getToken(code);
                            // Get user info
                            auth.setCredentials(tokens);
                            const gmail = google.gmail({ version: 'v1', auth });
                            const profile = await gmail.users.getProfile({ userId: 'me' });
                            // Create user session
                            const session = {
                                userId,
                                userEmail: profile.data.emailAddress || undefined,
                                accessToken: tokens.access_token,
                                refreshToken: tokens.refresh_token,
                                expiryDate: tokens.expiry_date,
                                authenticated: true
                            };
                            this.sessions.set(userId, session);
                            this.saveUserSessions();
                            res.end(`<html><body><h1>Authentication Successful!</h1><p>Welcome ${profile.data.emailAddress}!</p><p>You can close this window.</p></body></html>`);
                            server.close();
                            this.authServers.delete(userId);
                            logger.log(`User ${profile.data.emailAddress} authenticated successfully`);
                            resolve();
                        }
                        catch (error) {
                            res.end(`<html><body><h1>Authentication Error</h1><p>Failed to complete authentication</p></body></html>`);
                            server.close();
                            this.authServers.delete(userId);
                            reject(error);
                        }
                        return;
                    }
                    res.end('<html><body><h1>Invalid Request</h1></body></html>');
                }
                else {
                    res.end(`<html><body><h1>Gmail MCP Server OAuth2</h1><p>Waiting for authentication for user ${userId}...</p></body></html>`);
                }
            });
            server.listen(port, () => {
                this.authServers.set(userId, server);
                logger.log(`OAuth2 callback server started for user ${userId} on port ${port}`);
                resolve();
            });
            server.on('error', (err) => {
                reject(err);
            });
            // Auto-cleanup after 10 minutes
            setTimeout(() => {
                if (this.authServers.has(userId)) {
                    server.close();
                    this.authServers.delete(userId);
                    logger.log(`Authentication timeout for user ${userId}`);
                }
            }, 600000);
        });
    }
    /**
     * Get authenticated Gmail client for a user
     */
    async getGmailClientForUser(userId) {
        let session = this.sessions.get(userId);
        if (!session) {
            // Allow callers to address a session by its email address
            // instead of the generated userId, for a friendlier API.
            session = Array.from(this.sessions.values()).find(s => s.userEmail === userId);
        }
        if (!session || !session.authenticated) {
            throw new Error(`User ${userId} is not authenticated`);
        }
        const auth = this.createOAuth2Client();
        auth.setCredentials({
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
            expiry_date: session.expiryDate
        });
        // Check if token needs refresh
        try {
            await auth.getAccessToken();
        }
        catch (error) {
            // Token expired, try to refresh
            if (session.refreshToken) {
                try {
                    const refreshResponse = await auth.refreshAccessToken();
                    const newTokens = refreshResponse.credentials;
                    if (newTokens.access_token) {
                        session.accessToken = newTokens.access_token;
                    }
                    if (newTokens.expiry_date) {
                        session.expiryDate = newTokens.expiry_date;
                    }
                    this.saveUserSessions();
                    logger.log(`Refreshed tokens for user ${userId}`);
                }
                catch (refreshError) {
                    logger.error(`Failed to refresh tokens for user ${userId}:`, refreshError);
                    throw new Error(`Authentication expired for user ${userId}. Please re-authenticate.`);
                }
            }
            else {
                throw new Error(`Authentication expired for user ${userId}. Please re-authenticate.`);
            }
        }
        return google.gmail({ version: 'v1', auth });
    }
    /**
     * Get user session info
     */
    getUserSession(userId) {
        return this.sessions.get(userId) || null;
    }
    /**
     * List all authenticated users
     */
    getAuthenticatedUsers() {
        return Array.from(this.sessions.values()).filter(session => session.authenticated);
    }
    /**
     * Remove user session
     */
    removeUser(userId) {
        const removed = this.sessions.delete(userId);
        if (removed) {
            this.saveUserSessions();
            logger.log(`Removed user session: ${userId}`);
        }
        return removed;
    }
    /**
     * Clear all user sessions
     */
    clearAllSessions() {
        this.sessions.clear();
        this.saveUserSessions();
        logger.log('Cleared all user sessions');
    }
}
// Export singleton instance
export const multiUserAuth = new MultiUserGmailAuth();
