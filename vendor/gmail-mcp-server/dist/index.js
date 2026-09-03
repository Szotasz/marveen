/**
 * Gmail MCP Server
 * A comprehensive server implementation using Model Context Protocol for Gmail API
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { gmailAuth } from "./utils/gmail-auth.js";
import { gmailOperations } from "./utils/gmail-operations.js";
import { multiUserAuth } from "./utils/multi-user-auth.js";
import { logger } from './utils/api.js';
import { ThreadReconstructor, ConversationManager, EmailIntelligence, ProactiveReminderSystem } from './utils/threading-intelligence.js';
let gmailConfig;
function parseArgs() {
    const args = process.argv.slice(2);
    const config = {
        setupAuth: false,
        resetAuth: false,
        debug: false,
        nonInteractive: false,
        multiUser: false,
        forceManualAuth: false
    };
    // Check environment variable for forcing manual auth
    if (process.env.GMAIL_FORCE_MANUAL_AUTH === 'true' || process.env.GMAIL_FORCE_MANUAL_AUTH === '1') {
        config.forceManualAuth = true;
    }
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--setup-auth') {
            config.setupAuth = true;
        }
        else if (arg === '--reset-auth') {
            config.resetAuth = true;
        }
        else if (arg === '--debug' || arg === '-d') {
            config.debug = true;
        }
        else if (arg === '--non-interactive' || arg === '-n') {
            config.nonInteractive = true;
        }
        else if (arg === '--multi-user') {
            config.multiUser = true;
        }
        else if (arg === '--force-manual-auth') {
            config.forceManualAuth = true;
        }
    }
    return config;
}
const server = new Server({
    name: "gmail-mcp-server",
    version: "1.0.24"
}, {
    capabilities: {
        resources: {
            read: true,
            list: true,
            templates: true
        },
        tools: {
            list: true,
            call: true
        },
        prompts: {
            list: true,
            get: true
        },
        resourceTemplates: {
            list: true
        }
    }
});
// Set up the resource listing request handler
server.setRequestHandler(ListResourcesRequestSchema, async () => {
    logger.log('Received list resources request');
    return { resources: [] };
});
/**
 * Handler for reading resource information.
 */
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    logger.log('Received read resource request: ' + JSON.stringify(request));
    throw new Error("Resource reading not implemented");
});
/**
 * Handler for getting a prompt.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    logger.log('Received get prompt request: ' + JSON.stringify(request));
    throw new Error("Prompt reading not implemented");
});
/**
 * Handler for listing prompts.
 */
server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    logger.log('Received list prompts request: ' + JSON.stringify(request));
    throw new Error("Prompt listing not implemented");
});
/**
 * Handler for listing resource templates.
 */
server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
    logger.log('Received list resource templates request: ' + JSON.stringify(request));
    throw new Error("Resource template listing not implemented");
});
/**
 * Helper function to check if user is authenticated and provide guidance if not
 */
async function checkAuthenticationWithGuidance() {
    if (!await gmailAuth.isConfigured()) {
        return {
            isAuthenticated: false,
            errorResponse: {
                content: [
                    {
                        type: "text",
                        text: "❌ Gmail credentials not configured.\n\nPlease set up your OAuth2 credentials first:\n1. Set environment variables GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET\n2. Or run: gmail-mcp-server --setup-auth"
                    }
                ],
                isError: true
            }
        };
    }
    if (!await gmailAuth.isAuthenticated()) {
        return {
            isAuthenticated: false,
            errorResponse: {
                content: [
                    {
                        type: "text",
                        text: "🔐 **Authentication Required**\n\nTo use Gmail tools, please authenticate first:\n\n**Use the `authenticate` tool to get a clickable authentication link**\n\n🔗 Manual authentication is used for security and compatibility with all environments (servers, containers, etc.)\n\nAfter authentication, you can use all Gmail tools!"
                    }
                ],
                isError: true
            }
        };
    }
    return { isAuthenticated: true };
}
/**
 * List available tools for interacting with Gmail.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    const baseTools = [
        {
            name: "gmail_send_email",
            description: "Send an email message with support for HTML content, attachments, and international characters. Supports both plain text and HTML emails with proper multipart structure. For attachments: use base64 encoded content OR provide ABSOLUTE file paths (e.g., '/full/path/to/file.pdf'). Relative paths will fail.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    to: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of recipient email addresses"
                    },
                    cc: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of CC recipient email addresses (optional)"
                    },
                    bcc: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of BCC recipient email addresses (optional)"
                    },
                    subject: {
                        type: "string",
                        description: "Email subject line with full support for international characters"
                    },
                    text: {
                        type: "string",
                        description: "Plain text content of the email (optional if html is provided)"
                    },
                    html: {
                        type: "string",
                        description: "HTML content of the email (optional if text is provided)"
                    },
                    replyTo: {
                        type: "string",
                        description: "Reply-to email address (optional)"
                    },
                    attachments: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                filename: {
                                    type: "string",
                                    description: "Name of the attachment file"
                                },
                                content: {
                                    type: "string",
                                    description: "Base64 encoded content of the attachment OR ABSOLUTE file path to read from disk. For base64: encode your file content first. For file path: provide FULL ABSOLUTE path like '/Users/username/Documents/file.pdf' or 'C:\\Users\\username\\Documents\\file.pdf'. Relative paths like 'uploads/file.pdf' will fail - always use complete paths."
                                },
                                contentType: {
                                    type: "string",
                                    description: "MIME type of the attachment (optional, auto-detected if not provided)"
                                }
                            },
                            required: ["filename", "content"]
                        },
                        description: "List of email attachments (optional)"
                    }
                },
                required: ["to", "subject"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_read_email",
            description: "Read email message by ID with advanced MIME structure handling. Returns full email content including headers, body, and attachment information.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    messageId: {
                        type: "string",
                        description: "Gmail message ID to retrieve"
                    },
                    format: {
                        type: "string",
                        enum: ["minimal", "full", "raw", "metadata"],
                        description: "Level of detail to retrieve (default: full)",
                        default: "full"
                    },
                    includeContent: {
                        type: "boolean",
                        description: "Whether to extract and include email content (text/html)",
                        default: true
                    }
                },
                required: ["messageId"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_search_emails",
            description: "Enhanced email search with natural language processing, fuzzy matching, and cross-reference detection. Supports queries like 'Find income tax notice from May' or 'Show me emails about PAN ANYPS1039E'. Automatically detects natural language and applies intelligent matching.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    query: {
                        type: "string",
                        description: "Search query - supports both natural language (e.g., 'Find income tax notice from May') and Gmail syntax (e.g., 'is:unread has:attachment'). Enhanced search automatically activates for natural language queries."
                    },
                    from: {
                        type: "string",
                        description: "Search for emails from specific sender"
                    },
                    to: {
                        type: "string",
                        description: "Search for emails to specific recipient"
                    },
                    subject: {
                        type: "string",
                        description: "Search for emails with specific subject"
                    },
                    after: {
                        type: "string",
                        description: "Search for emails after date (format: YYYY/MM/DD)"
                    },
                    before: {
                        type: "string",
                        description: "Search for emails before date (format: YYYY/MM/DD)"
                    },
                    hasAttachment: {
                        type: "boolean",
                        description: "Filter emails that have attachments"
                    },
                    label: {
                        type: "string",
                        description: "Search within specific label/folder (default: INBOX). Common values: INBOX, SENT, DRAFT, TRASH, SPAM",
                        default: "INBOX"
                    },
                    isUnread: {
                        type: "boolean",
                        description: "Filter for unread emails only"
                    },
                    maxResults: {
                        type: "number",
                        description: "Maximum number of results to return (default: 50, max: 500)",
                        minimum: 1,
                        maximum: 500,
                        default: 50
                    },
                    useEnhancedSearch: {
                        type: "boolean",
                        description: "Force enhanced search with natural language processing and fuzzy matching (default: auto-detected)",
                        default: false
                    },
                    fuzzyThreshold: {
                        type: "number",
                        description: "Fuzzy matching threshold (0-100, default: 80). Higher values require more exact matches.",
                        minimum: 0,
                        maximum: 100,
                        default: 80
                    },
                    includeCrossReferences: {
                        type: "boolean",
                        description: "Include cross-reference information for related emails (default: true)",
                        default: true
                    }
                },
                additionalProperties: false
            }
        },
        {
            name: "analyze_conversation",
            description: "Analyze a conversation thread for a given email. Reconstructs the full thread (including forwards/replies), extracts participants, timeline, topics, references, and classifies each email for importance, urgency, deadlines, and suggests proactive reminders.",
            inputSchema: {
                type: "object",
                properties: {
                    emailId: { type: "string", description: "Starting email ID for the analysis" },
                    includeReminders: { type: "boolean", description: "Include proactive reminder suggestions", default: true },
                    maxThreadSize: { type: "number", description: "Maximum number of emails to analyze in the thread", default: 20 }
                },
                required: ["emailId"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_mark_email",
            description: "Mark email as read or unread. Useful for managing email status and organizing your inbox.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    messageId: {
                        type: "string",
                        description: "Gmail message ID to mark"
                    },
                    read: {
                        type: "boolean",
                        description: "True to mark as read, false to mark as unread"
                    }
                },
                required: ["messageId", "read"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_move_email",
            description: "Move email to different label/folder. Can add labels and remove existing ones in a single operation.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    messageId: {
                        type: "string",
                        description: "Gmail message ID to move"
                    },
                    labelId: {
                        type: "string",
                        description: "Label ID to add to the email"
                    },
                    removeLabelIds: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of label IDs to remove from the email (optional)"
                    }
                },
                required: ["messageId", "labelId"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_delete_email",
            description: "Permanently delete an email message. Use with caution as this action cannot be undone.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    messageId: {
                        type: "string",
                        description: "Gmail message ID to delete"
                    }
                },
                required: ["messageId"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_list_attachments",
            description: "REQUIRED FIRST STEP: List all attachments in a Gmail message before downloading. Shows attachment index, ID, filename, content type, and size. Use the index (0, 1, 2, etc.) or copy the exact attachmentId for gmail_get_attachment.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    messageId: {
                        type: "string",
                        description: "Gmail message ID to list attachments from"
                    }
                },
                required: ["messageId"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_get_attachment",
            description: "Download Gmail attachment and automatically save to local file system. Base64 content is decoded to binary file and saved with unique timestamped filename. Returns full file path and file:// URL for direct access. IMPORTANT: Use 'gmail_list_attachments' first to see available attachments, then use the index (0, 1, 2, etc.) or copy the exact attachmentId from the list.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    messageId: {
                        type: "string",
                        description: "Gmail message ID containing the attachment"
                    },
                    attachmentId: {
                        type: "string",
                        description: "Attachment ID or index (0, 1, 2, etc.) to download. REQUIRED: First run 'gmail_list_attachments' with the same messageId to see available attachments and their indexes/IDs."
                    },
                    customPath: {
                        type: "string",
                        description: "Custom download directory path (optional, defaults to ./downloads)"
                    }
                },
                required: ["messageId", "attachmentId"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_draft",
            description: "Comprehensive draft email management. Create, list, get, update, delete, and send drafts through a single tool.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "User ID or email of an account authenticated via gmail_authenticate_user (multi-user mode). Optional: omit to use the primary/default account."
                    },
                    action: {
                        type: "string",
                        enum: ["create", "list", "get", "update", "delete", "send"],
                        description: "Action to perform: create, list, get, update, delete, or send"
                    },
                    draftId: {
                        type: "string",
                        description: "Draft ID (required for get, update, delete, send actions)"
                    },
                    to: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of recipient email addresses (required for create/update)"
                    },
                    cc: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of CC recipient email addresses (optional for create/update)"
                    },
                    bcc: {
                        type: "array",
                        items: { type: "string" },
                        description: "List of BCC recipient email addresses (optional for create/update)"
                    },
                    subject: {
                        type: "string",
                        description: "Email subject line (required for create/update)"
                    },
                    text: {
                        type: "string",
                        description: "Plain text content (optional if html provided for create/update)"
                    },
                    html: {
                        type: "string",
                        description: "HTML content (optional if text provided for create/update)"
                    },
                    replyTo: {
                        type: "string",
                        description: "Reply-to email address (optional for create/update)"
                    },
                    attachments: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                filename: {
                                    type: "string",
                                    description: "Name of the attachment file"
                                },
                                content: {
                                    type: "string",
                                    description: "Base64 encoded content of the attachment"
                                },
                                contentType: {
                                    type: "string",
                                    description: "MIME type of the attachment (optional)"
                                }
                            },
                            required: ["filename", "content"]
                        },
                        description: "List of email attachments (optional for create/update)"
                    },
                    maxResults: {
                        type: "number",
                        description: "Maximum number of drafts to return for list action (default: 50)",
                        minimum: 1,
                        maximum: 500,
                        default: 50
                    }
                },
                required: ["action"],
                additionalProperties: false
            }
        },
        {
            name: "gmail_logout",
            description: "Sign out and clear Gmail authentication credentials. Useful for switching accounts or ending the session.",
            inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: "gmail_system_status",
            description: "Check the system status including feature availability, circuit breaker states, and resilience metrics.",
            inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
            }
        },
        {
            name: "gmail_performance_metrics",
            description: "Get comprehensive performance metrics including cache hit rates, memory usage, batch operation efficiency, and connection pool statistics.",
            inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false
            }
        }
    ];
    // Add multi-user specific tools
    const multiUserTools = [
        {
            name: "gmail_authenticate_user",
            description: "Start authentication flow for a new user. Returns authentication URL that user needs to visit.",
            inputSchema: {
                type: "object",
                properties: {
                    userEmail: {
                        type: "string",
                        description: "User's email address (optional, for identification)"
                    }
                },
                additionalProperties: false
            }
        },
        {
            name: "gmail_manage_session",
            description: "Manage your Gmail authentication session (view info or remove session). User-specific and secure.",
            inputSchema: {
                type: "object",
                properties: {
                    userId: {
                        type: "string",
                        description: "Your User ID to manage"
                    },
                    action: {
                        type: "string",
                        enum: ["info", "remove"],
                        description: "Action to perform: 'info' (view session details) or 'remove' (delete session)",
                        default: "info"
                    }
                },
                required: ["userId"],
                additionalProperties: false
            }
        }
    ];
    // Add one-time authentication tool for single-user mode
    const oneTimeAuthTools = [
        {
            name: "gmail_authenticate",
            description: "Authenticate with Gmail using manual authentication (provides clickable link). Secure and compatible with all environments.",
            inputSchema: {
                type: "object",
                properties: {
                    force: {
                        type: "boolean",
                        description: "Force re-authentication even if already authenticated (default: false)",
                        default: false
                    }
                },
                additionalProperties: false
            }
        }
    ];
    if (gmailConfig.multiUser) {
        return { tools: [...baseTools, ...multiUserTools] };
    }
    // For single-user mode, always include authentication tool
    return { tools: [...baseTools, ...oneTimeAuthTools] };
});
/**
 * Handle tool calls to the Gmail API.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    logger.log('Received call tool request: ' + JSON.stringify(request));
    switch (request.params.name) {
        case "gmail_authenticate":
            try {
                const args = request.params.arguments || {};
                const { force = false } = args;
                // Check if already authenticated and not forcing re-auth
                if (!force && await gmailAuth.isAuthenticated()) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "✅ You're already authenticated! Gmail access is ready.\n\nYou can now use all Gmail tools. If you want to re-authenticate, use the 'force' option."
                            }
                        ]
                    };
                }
                // Check if credentials are configured
                if (!await gmailAuth.isConfigured()) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "❌ Gmail credentials not configured.\n\nPlease set up your OAuth2 credentials first:\n1. Set environment variables GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET\n2. Or run: gmail-mcp-server --setup-auth"
                            }
                        ],
                        isError: true
                    };
                }
                try {
                    // Manual authentication - get authentication URL without opening browser
                    const authUrl = await gmailAuth.getAuthUrl();
                    return {
                        content: [
                            {
                                type: "text",
                                text: `🔗 **Click here to authenticate with Gmail:**

${authUrl}

📋 **Instructions:**
1. Click the URL above to authenticate
2. Sign in with your Gmail account  
3. Grant permissions to the app
4. You'll see "Authentication Successful!"
5. Return here and use Gmail tools!

⚡ **After authentication, you can use:**
- gmail_send_email, gmail_read_email, gmail_search_emails
- gmail_move_email, gmail_mark_email, gmail_delete_email
- gmail_draft
- And more!

💡 The authentication will be stored securely for future use.`
                            }
                        ]
                    };
                }
                catch (authError) {
                    const errorMessage = authError instanceof Error ? authError.message : 'Unknown error';
                    return {
                        content: [
                            {
                                type: "text",
                                text: `❌ Authentication failed: ${errorMessage}\n\nPlease try again or check your OAuth2 credentials.`
                            }
                        ],
                        isError: true
                    };
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error during authentication: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_logout":
            try {
                // Check if we're in multi-user mode
                if (gmailConfig.multiUser) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "❌ Logout not available in multi-user mode.\n\nUse 'manage_session' with action 'remove' and your userId to sign out."
                            }
                        ],
                        isError: true
                    };
                }
                // Check if user is authenticated
                const isAuthenticated = await gmailAuth.isAuthenticated();
                if (!isAuthenticated) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "ℹ️ You're not currently signed in.\n\nUse the 'authenticate' tool to sign in to Gmail."
                            }
                        ]
                    };
                }
                // Clear authentication by removing token file
                try {
                    gmailAuth.resetAuth();
                    gmailOperations.resetClient(); // Reset cached Gmail client
                    return {
                        content: [
                            {
                                type: "text",
                                text: "✅ Successfully signed out of Gmail!\n\n🔐 Your authentication has been cleared.\n\n💡 To access Gmail again, use the 'authenticate' tool to sign in."
                            }
                        ]
                    };
                }
                catch (clearError) {
                    const errorMessage = clearError instanceof Error ? clearError.message : 'Unknown error';
                    return {
                        content: [
                            {
                                type: "text",
                                text: `❌ Error clearing authentication: ${errorMessage}\n\nYou may need to manually delete the token file.`
                            }
                        ],
                        isError: true
                    };
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error during logout: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_authenticate_user":
            try {
                if (!gmailConfig.multiUser) {
                    throw new Error("Multi-user mode not enabled. Restart server with --multi-user flag.");
                }
                const args = request.params.arguments || {};
                const { userEmail } = args;
                const authResult = await multiUserAuth.authenticateNewUser(userEmail);
                return {
                    content: [
                        {
                            type: "text",
                            text: `🔐 Authentication started for user!

User ID: ${authResult.userId}
Authentication URL: ${authResult.authUrl}
Server Port: ${authResult.port}

🚀 Please visit the authentication URL to complete the process.
The authentication will timeout in 10 minutes.

After successful authentication, use this User ID for all Gmail operations: ${authResult.userId}`
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error starting authentication: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_manage_session":
            try {
                if (!gmailConfig.multiUser) {
                    throw new Error("Multi-user mode not enabled. Restart server with --multi-user flag.");
                }
                const args = request.params.arguments || {};
                const { userId, action = "info" } = args;
                if (!userId) {
                    throw new Error("'userId' is required");
                }
                const session = multiUserAuth.getUserSession(userId);
                if (!session) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `❌ User session ${userId} not found.`
                            }
                        ]
                    };
                }
                if (action === "info") {
                    const responseText = `📋 User Session Info:

User ID: ${session.userId}
Email: ${session.userEmail || 'Unknown'}
Authenticated: ${session.authenticated ? '✅' : '❌'}
Token Expires: ${new Date(session.expiryDate).toLocaleString()}
Status: ${session.authenticated ? 'Active' : 'Inactive'}`;
                    return {
                        content: [
                            {
                                type: "text",
                                text: responseText
                            }
                        ]
                    };
                }
                else {
                    // action === "remove"
                    const removed = multiUserAuth.removeUser(userId);
                    return {
                        content: [
                            {
                                type: "text",
                                text: removed
                                    ? `✅ User session ${userId} removed successfully.`
                                    : `❌ User session ${userId} not found.`
                            }
                        ]
                    };
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error managing user session: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_send_email":
            try {
                // Check authentication first
                const authCheck = await checkAuthenticationWithGuidance();
                if (!authCheck.isAuthenticated) {
                    return authCheck.errorResponse;
                }
                const args = request.params.arguments || {};
                const { userId, to, cc, bcc, subject, text, html, replyTo, attachments } = args;
                if (!to || !Array.isArray(to) || to.length === 0) {
                    throw new Error("'to' field is required and must be a non-empty array");
                }
                if (!subject) {
                    throw new Error("'subject' field is required");
                }
                if (!text && !html) {
                    throw new Error("Either 'text' or 'html' content is required");
                }
                const emailMessage = {
                    to,
                    cc,
                    bcc,
                    subject,
                    text,
                    html,
                    replyTo,
                    attachments: attachments?.map((att) => ({
                        filename: att.filename,
                        content: att.content,
                        contentType: att.contentType,
                        encoding: 'base64'
                    }))
                };
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                const result = await gmailOperations.sendEmail(emailMessage, overrideClient);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Email sent successfully!\nMessage ID: ${result.id}\nThread ID: ${result.threadId}\nRecipients: ${to.join(', ')}\nSubject: ${subject}`
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error sending email: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_read_email":
            try {
                // Check authentication first
                const authCheck = await checkAuthenticationWithGuidance();
                if (!authCheck.isAuthenticated) {
                    return authCheck.errorResponse;
                }
                const args = request.params.arguments || {};
                const { userId, messageId, format = 'full', includeContent = true } = args;
                if (!messageId) {
                    throw new Error("'messageId' is required");
                }
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                const email = await gmailOperations.getEmail(messageId, format, overrideClient);
                let responseText = `Email ID: ${email.id}\nThread ID: ${email.threadId}\nSnippet: ${email.snippet}\nLabels: ${email.labelIds?.join(', ') || 'None'}\n`;
                if (email.payload && email.payload.headers) {
                    const headers = email.payload.headers;
                    const fromHeader = headers.find((h) => h.name === 'From');
                    const toHeader = headers.find((h) => h.name === 'To');
                    const subjectHeader = headers.find((h) => h.name === 'Subject');
                    const dateHeader = headers.find((h) => h.name === 'Date');
                    responseText += `From: ${fromHeader?.value || 'Unknown'}\n`;
                    responseText += `To: ${toHeader?.value || 'Unknown'}\n`;
                    responseText += `Subject: ${subjectHeader?.value || 'No Subject'}\n`;
                    responseText += `Date: ${dateHeader?.value || 'Unknown'}\n`;
                }
                if (includeContent && email.payload) {
                    const content = gmailOperations.extractEmailContent(email.payload);
                    if (content.text) {
                        responseText += `\n--- Text Content ---\n${content.text}\n`;
                    }
                    if (content.html) {
                        responseText += `\n--- HTML Content ---\n${content.html}\n`;
                    }
                    if (content.attachments.length > 0) {
                        responseText += `\n--- Attachments ---\n`;
                        content.attachments.forEach((att, index) => {
                            responseText += `${index + 1}. ${att.filename} (${att.mimeType}, ${att.size} bytes)\n`;
                        });
                    }
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: responseText
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error reading email: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_search_emails":
            try {
                // Check authentication first
                const authCheck = await checkAuthenticationWithGuidance();
                if (!authCheck.isAuthenticated) {
                    return authCheck.errorResponse;
                }
                const args = request.params.arguments || {};
                const { userId, ...searchArgs } = args;
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                const searchCriteria = {
                    query: searchArgs.query,
                    from: searchArgs.from,
                    to: searchArgs.to,
                    subject: searchArgs.subject,
                    after: searchArgs.after,
                    before: searchArgs.before,
                    hasAttachment: searchArgs.hasAttachment,
                    label: searchArgs.label || 'INBOX',
                    isUnread: searchArgs.isUnread,
                    maxResults: searchArgs.maxResults || 50,
                    useEnhancedSearch: searchArgs.useEnhancedSearch,
                    fuzzyThreshold: searchArgs.fuzzyThreshold,
                    includeCrossReferences: searchArgs.includeCrossReferences
                };
                const result = await gmailOperations.searchEmails(searchCriteria, overrideClient);
                if (result.messages.length === 0) {
                    const label = searchArgs.label || 'INBOX';
                    const searchTerm = searchArgs.query ? 'matching the search criteria' : `in ${label}`;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `No emails found ${searchTerm}.`
                            }
                        ]
                    };
                }
                const isListing = !searchArgs.query && !searchArgs.from && !searchArgs.to && !searchArgs.subject && !searchArgs.after && !searchArgs.before && !searchArgs.hasAttachment && !searchArgs.isUnread;
                const label = searchArgs.label || 'INBOX';
                let responseText = isListing ? `Found ${result.messages.length} emails in ${label}:\n\n` : `Found ${result.messages.length} emails:\n\n`;
                // Check if enhanced search was used
                if (result.enhancedResults) {
                    responseText += `🔍 **Enhanced Search Results**\n`;
                    responseText += `Query: "${searchArgs.query}"\n`;
                    responseText += `Search Type: Natural Language Processing with Fuzzy Matching\n`;
                    responseText += `Match Threshold: ${searchArgs.fuzzyThreshold || 80}%\n\n`;
                }
                result.messages.forEach((email, index) => {
                    const fromHeader = email.payload?.headers?.find((h) => h.name === 'From');
                    const subjectHeader = email.payload?.headers?.find((h) => h.name === 'Subject');
                    const dateHeader = email.payload?.headers?.find((h) => h.name === 'Date');
                    responseText += `${index + 1}. ID: ${email.id}\n`;
                    responseText += `   From: ${fromHeader?.value || 'Unknown'}\n`;
                    responseText += `   Subject: ${subjectHeader?.value || 'No Subject'}\n`;
                    responseText += `   Date: ${dateHeader?.value || 'Unknown'}\n`;
                    responseText += `   Snippet: ${email.snippet}\n`;
                    responseText += `   Labels: ${email.labelIds?.join(', ') || 'None'}\n`;
                    // Add enhanced search information if available
                    if (result.enhancedResults) {
                        const enhancedResult = result.enhancedResults.searchResults.find(r => r.email.id === email.id);
                        if (enhancedResult) {
                            responseText += `   Match Score: ${enhancedResult.matchScore.toFixed(1)}%\n`;
                            responseText += `   Relevance: ${enhancedResult.relevance.toUpperCase()}\n`;
                            if (enhancedResult.crossReferences && enhancedResult.crossReferences.length > 0) {
                                responseText += `   Related Emails: ${enhancedResult.crossReferences.length} found\n`;
                            }
                        }
                    }
                    responseText += `\n`;
                });
                // Add cross-reference information if available
                if (result.enhancedResults && result.enhancedResults.crossReferences.length > 0) {
                    responseText += `\n🔗 **Cross-References Found:**\n`;
                    result.enhancedResults.crossReferences.slice(0, 5).forEach((ref, index) => {
                        responseText += `${index + 1}. Email ID: ${ref.emailId}\n`;
                        responseText += `   Relationship: ${ref.relationship.replace('_', ' ')}\n`;
                        responseText += `   Confidence: ${ref.confidence.toFixed(1)}%\n`;
                        responseText += `   Reason: ${ref.reason}\n\n`;
                    });
                }
                if (result.nextPageToken) {
                    responseText += `Note: More results available. Use pagination to retrieve additional emails.`;
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: responseText
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error searching emails: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_mark_email":
            try {
                const args = request.params.arguments || {};
                const { userId, messageId, read } = args;
                if (!messageId) {
                    throw new Error("'messageId' is required");
                }
                if (typeof read !== 'boolean') {
                    throw new Error("'read' must be a boolean value");
                }
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                await gmailOperations.markEmail(messageId, read, overrideClient);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Email ${messageId} marked as ${read ? 'read' : 'unread'} successfully.`
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error marking email: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_move_email":
            try {
                const args = request.params.arguments || {};
                const { userId, messageId, labelId, removeLabelIds } = args;
                if (!messageId) {
                    throw new Error("'messageId' is required");
                }
                if (!labelId) {
                    throw new Error("'labelId' is required");
                }
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                await gmailOperations.moveToLabel(messageId, labelId, removeLabelIds, overrideClient);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Email ${messageId} moved to label ${labelId} successfully.`
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error moving email: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_delete_email":
            try {
                const args = request.params.arguments || {};
                const { userId, messageId } = args;
                if (!messageId) {
                    throw new Error("'messageId' is required");
                }
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                await gmailOperations.deleteEmail(messageId, overrideClient);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Email ${messageId} deleted successfully.`
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error deleting email: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_list_attachments":
            try {
                const args = request.params.arguments || {};
                const { userId, messageId } = args;
                if (!messageId) {
                    throw new Error("'messageId' is required");
                }
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                const attachments = await gmailOperations.listAttachments(messageId, overrideClient);
                if (attachments.length === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: "No attachments found in this message."
                            }
                        ]
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                messageId,
                                totalAttachments: attachments.length,
                                attachments: attachments.map(att => ({
                                    index: att.index,
                                    attachmentId: att.attachmentId,
                                    filename: att.filename,
                                    contentType: att.contentType,
                                    size: att.size,
                                    sizeFormatted: `${(att.size / 1024).toFixed(1)} KB`
                                }))
                            }, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error listing attachments: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_get_attachment":
            try {
                const args = request.params.arguments || {};
                const { userId, messageId, attachmentId, customPath } = args;
                if (!messageId) {
                    throw new Error("'messageId' is required");
                }
                if (!attachmentId) {
                    throw new Error("'attachmentId' is required");
                }
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                // Use the new method that saves to local file
                const result = await gmailOperations.getAttachmentToLocal(messageId, attachmentId, customPath, overrideClient);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                message: "Attachment downloaded successfully",
                                filePath: result.filePath,
                                filename: result.filename,
                                size: result.size,
                                contentType: result.contentType,
                                fileUrl: result.fileUrl
                            }, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error downloading attachment: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_draft":
            try {
                // Check authentication first
                const authCheck = await checkAuthenticationWithGuidance();
                if (!authCheck.isAuthenticated) {
                    return authCheck.errorResponse;
                }
                const args = request.params.arguments || {};
                const { userId, action, draftId, to, cc, bcc, subject, text, html, replyTo, attachments, maxResults } = args;
                if (!action) {
                    throw new Error("'action' is required");
                }
                if (action === "create" && (!to || !subject)) {
                    throw new Error("'to' and 'subject' are required for creating a draft");
                }
                if (action === "update" && !draftId) {
                    throw new Error("'draftId' is required for updating a draft");
                }
                if (action === "delete" && !draftId) {
                    throw new Error("'draftId' is required for deleting a draft");
                }
                if (action === "send" && !draftId) {
                    throw new Error("'draftId' is required for sending a draft");
                }
                const overrideClient = (gmailConfig.multiUser && userId) ? await multiUserAuth.getGmailClientForUser(userId) : undefined;
                switch (action) {
                    case "create": {
                        const createResult = await gmailOperations.createDraft({ to, cc, bcc, subject, text, html, replyTo, attachments }, overrideClient);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Draft created successfully!\nDraft ID: ${createResult.id}\nMessage ID: ${createResult.message.id}\nRecipients: ${to.join(', ')}\nSubject: ${subject}`
                                }
                            ]
                        };
                    }
                    case "list": {
                        const listResult = await gmailOperations.listDrafts(maxResults, overrideClient);
                        if (listResult.drafts.length === 0) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "No drafts found."
                                    }
                                ]
                            };
                        }
                        let listText = `Found ${listResult.drafts.length} drafts:\n\n`;
                        listResult.drafts.forEach((draft, index) => {
                            const subjectHeader = draft.message.payload?.headers?.find((h) => h.name === 'Subject');
                            listText += `${index + 1}. Draft ID: ${draft.id}\n`;
                            listText += `   Message ID: ${draft.message.id}\n`;
                            listText += `   Subject: ${subjectHeader?.value || 'No Subject'}\n`;
                            listText += `   Snippet: ${draft.message.snippet}\n\n`;
                        });
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: listText
                                }
                            ]
                        };
                    }
                    case "get": {
                        const getResult = await gmailOperations.getDraft(draftId, overrideClient);
                        const subjectHeader = getResult.message.payload?.headers?.find((h) => h.name === 'Subject');
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Draft retrieved successfully!\nDraft ID: ${getResult.id}\nMessage ID: ${getResult.message.id}\nSubject: ${subjectHeader?.value || 'No Subject'}\nSnippet: ${getResult.message.snippet}`
                                }
                            ]
                        };
                    }
                    case "update": {
                        const updateResult = await gmailOperations.updateDraft(draftId, { to, cc, bcc, subject, text, html, replyTo, attachments }, overrideClient);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Draft updated successfully!\nDraft ID: ${updateResult.id}\nMessage ID: ${updateResult.message.id}\nRecipients: ${to.join(', ')}\nSubject: ${subject}`
                                }
                            ]
                        };
                    }
                    case "delete": {
                        await gmailOperations.deleteDraft(draftId, overrideClient);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Draft deleted successfully! Draft ID: ${draftId}`
                                }
                            ]
                        };
                    }
                    case "send": {
                        const sendResult = await gmailOperations.sendDraft(draftId, overrideClient);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Draft sent successfully!\nMessage ID: ${sendResult.id}\nThread ID: ${sendResult.threadId}`
                                }
                            ]
                        };
                    }
                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error managing draft: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "analyze_conversation":
            try {
                const args = request.params.arguments || {};
                const { emailId, includeReminders = true, maxThreadSize = 20 } = args;
                // Check authentication first
                const authCheck = await checkAuthenticationWithGuidance();
                if (!authCheck.isAuthenticated) {
                    return authCheck.errorResponse;
                }
                // Fetch all emails (limit for performance)
                const allResult = await gmailOperations.searchEmails({ maxResults: 200 });
                const allEmails = allResult.messages;
                if (!allEmails || allEmails.length === 0) {
                    return { content: [{ type: "text", text: "No emails found in mailbox." }], isError: true };
                }
                // Map EmailInfo[] to ThreadedEmail[]
                const allThreadedEmails = allEmails.map(e => ({
                    id: e.id,
                    threadId: e.threadId,
                    subject: e.payload?.headers?.find((h) => h.name === 'Subject')?.value || '',
                    snippet: e.snippet,
                    payload: e.payload,
                    labelIds: e.labelIds,
                    internalDate: e.internalDate
                }));
                // Thread reconstruction
                const threadReconstructor = new ThreadReconstructor();
                const thread = threadReconstructor.reconstructConversation(emailId, allThreadedEmails);
                if (!thread || thread.length === 0) {
                    return { content: [{ type: "text", text: `No thread found for email ID: ${emailId}` }], isError: true };
                }
                const limitedThread = thread.slice(0, maxThreadSize);
                // Conversation context
                const conversationManager = new ConversationManager();
                const context = await conversationManager.preserveContext(limitedThread);
                // Intelligence analysis
                const intelligence = new EmailIntelligence();
                const classified = limitedThread.map(email => ({
                    id: email.id,
                    subject: email.subject,
                    from: email.payload?.headers?.find((h) => h.name === 'From')?.value || '',
                    classification: intelligence.classifyEmail(email)
                }));
                // Proactive reminders
                let reminders = [];
                if (includeReminders) {
                    const reminderSystem = new ProactiveReminderSystem();
                    for (const email of limitedThread) {
                        const cls = intelligence.classifyEmail(email);
                        reminders.push(...reminderSystem.createSmartReminders(email, cls).map(r => ({
                            emailId: email.id,
                            subject: email.subject,
                            ...r
                        })));
                    }
                }
                // Build response
                let responseText = `🧠 **Conversation Analysis for Email ID: ${emailId}**\n\n`;
                responseText += `**Thread Participants:** ${context.participants.join(', ')}\n`;
                responseText += `**Topics:** ${context.topics.join(', ')}\n`;
                responseText += `**Total Messages:** ${context.metadata.totalMessages}\n`;
                responseText += `**Duration:** ${context.metadata.duration}\n`;
                responseText += `**Last Activity:** ${context.metadata.lastActivity.toLocaleString()}\n\n`;
                responseText += `**Timeline:**\n`;
                context.timeline.forEach((t, i) => {
                    responseText += `  ${i + 1}. [${t.date.toLocaleDateString()}] ${t.subject}\n`;
                });
                responseText += `\n**References:**\n`;
                responseText += `  Documents: ${context.references.documents.join(', ') || 'None'}\n`;
                responseText += `  URLs: ${context.references.urls.join(', ') || 'None'}\n`;
                responseText += `  Attachments: ${context.references.attachments.join(', ') || 'None'}\n\n`;
                responseText += `**Email Intelligence:**\n`;
                classified.forEach((c, i) => {
                    responseText += `  ${i + 1}. [${c.id}] ${c.subject}\n`;
                    responseText += `     From: ${c.from}\n`;
                    responseText += `     Importance: ${c.classification.importance}\n`;
                    responseText += `     Category: ${c.classification.category}\n`;
                    responseText += `     Action Required: ${c.classification.actionRequired ? 'YES' : 'NO'}\n`;
                    if (c.classification.deadline)
                        responseText += `     Deadline: ${c.classification.deadline.toLocaleDateString()}\n`;
                    if (c.classification.reason)
                        responseText += `     Reason: ${c.classification.reason}\n`;
                });
                if (reminders.length > 0) {
                    responseText += `\n⏰ **Proactive Reminders:**\n`;
                    reminders.forEach((r, i) => {
                        responseText += `  ${i + 1}. [${r.emailId}] ${r.subject}\n`;
                        responseText += `     Reminder Date: ${r.reminderDate.toLocaleDateString()}\n`;
                        responseText += `     Type: ${r.type}\n`;
                        if (r.context?.originalDeadline)
                            responseText += `     Original Deadline: ${r.context.originalDeadline.toLocaleDateString()}\n`;
                    });
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: responseText
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error analyzing conversation: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_system_status":
            try {
                const systemStatus = gmailOperations.getSystemStatus();
                let responseText = "🔧 **Gmail MCP Server System Status**\n\n";
                responseText += "**Feature Status:**\n";
                for (const [feature, status] of Object.entries(systemStatus.features)) {
                    const statusStr = status;
                    const statusIcon = statusStr === 'enabled' ? '✅' : statusStr === 'disabled' ? '❌' : '⚠️';
                    responseText += `  ${statusIcon} ${feature.replace('_', ' ')}: ${statusStr.toUpperCase()}\n`;
                }
                responseText += "\n**Circuit Breakers:**\n";
                if (Object.keys(systemStatus.circuitBreakers).length === 0) {
                    responseText += "  No circuit breakers active\n";
                }
                else {
                    for (const [operation, stats] of Object.entries(systemStatus.circuitBreakers)) {
                        const circuitStats = stats;
                        const stateIcon = circuitStats.state === 'CLOSED' ? '✅' : circuitStats.state === 'OPEN' ? '❌' : '⚠️';
                        responseText += `  ${stateIcon} ${operation}: ${circuitStats.state} (Failures: ${circuitStats.failureCount}, Successes: ${circuitStats.successCount})\n`;
                    }
                }
                responseText += "\n**Rate Limiting:**\n";
                const rateLimitIcon = systemStatus.rateLimiting.active ? '⚠️' : '✅';
                responseText += `  ${rateLimitIcon} Rate Limiting: ${systemStatus.rateLimiting.active ? 'ACTIVE' : 'NORMAL'}\n`;
                responseText += "\n**Overall Health:** ";
                const allFeaturesOk = Object.values(systemStatus.features).every(status => status === 'enabled');
                const allCircuitsClosed = Object.values(systemStatus.circuitBreakers).every(stats => stats.state === 'CLOSED');
                const noRateLimit = !systemStatus.rateLimiting.active;
                if (allFeaturesOk && allCircuitsClosed && noRateLimit) {
                    responseText += "🟢 HEALTHY";
                }
                else if (Object.values(systemStatus.features).some(status => status === 'enabled')) {
                    responseText += "🟡 DEGRADED";
                }
                else {
                    responseText += "🔴 CRITICAL";
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: responseText
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error checking system status: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        case "gmail_performance_metrics":
            try {
                const performanceMetrics = gmailOperations.getPerformanceMetrics();
                let responseText = "📊 **Gmail MCP Server Performance Metrics**\n\n";
                responseText += "**Cache Performance:**\n";
                responseText += `  🎯 Cache Hit Rate: ${(performanceMetrics.cacheHitRate * 100).toFixed(1)}%\n`;
                responseText += `  📈 API Calls Reduced: ${performanceMetrics.apiCallsReduced}%\n`;
                responseText += "\n**Memory Usage:**\n";
                const memoryMB = (performanceMetrics.memoryUsage / 1024 / 1024).toFixed(1);
                responseText += `  💾 Current Memory: ${memoryMB} MB\n`;
                responseText += "\n**Connection Pool:**\n";
                responseText += `  🔗 Active Connections: ${performanceMetrics.activeConnections}\n`;
                responseText += "\n**Batch Operations:**\n";
                responseText += `  ⚡ Batch Success Rate: ${(performanceMetrics.batchSuccessRate * 100).toFixed(1)}%\n`;
                responseText += "\n**Response Time:**\n";
                responseText += `  ⏱️ Average Response: ${performanceMetrics.avgResponseTime}ms\n`;
                // Performance rating
                responseText += "\n**Performance Rating:** ";
                const cacheEfficient = performanceMetrics.cacheHitRate > 0.7; // 70%+ cache hit rate
                const memoryEfficient = performanceMetrics.memoryUsage < 200 * 1024 * 1024; // <200MB
                const batchEfficient = performanceMetrics.batchSuccessRate > 0.9; // 90%+ batch success
                if (cacheEfficient && memoryEfficient && batchEfficient) {
                    responseText += "🟢 EXCELLENT";
                }
                else if (performanceMetrics.cacheHitRate > 0.5) {
                    responseText += "🟡 GOOD";
                }
                else {
                    responseText += "🔴 NEEDS OPTIMIZATION";
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: responseText
                        }
                    ]
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                return {
                    content: [
                        {
                            type: "text",
                            text: `Error checking performance metrics: ${errorMessage}`
                        }
                    ],
                    isError: true
                };
            }
        default:
            throw new Error(`Unknown tool: ${request.params.name}`);
    }
});
async function main() {
    gmailConfig = parseArgs();
    // Handle special commands
    if (gmailConfig.setupAuth) {
        await gmailAuth.setupCredentials();
        return;
    }
    if (gmailConfig.resetAuth) {
        gmailAuth.resetAuth();
        gmailOperations.resetClient(); // Reset cached Gmail client
        if (gmailConfig.multiUser) {
            multiUserAuth.clearAllSessions();
            console.log('All authentication tokens and user sessions cleared.');
        }
        else {
            console.log('Authentication tokens cleared. Run the server again to re-authenticate.');
        }
        return;
    }
    logger.log('Starting Gmail MCP Server...');
    if (gmailConfig.multiUser) {
        logger.log('Multi-user mode enabled');
        console.error('📧 Gmail MCP Server starting in multi-user mode...');
        console.error('🔗 Use "authenticate_user" tool to add users');
    }
    else {
        // Just show startup message - credentials will be checked when tools are used
        console.error('📧 Gmail MCP Server starting...');
        console.error('🔐 Authentication will be handled when you use Gmail tools or call "authenticate"');
    }
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        logger.log('Gmail MCP Server started successfully');
        if (gmailConfig.multiUser) {
            console.error('🎉 Multi-user Gmail MCP Server ready!');
        }
    }
    catch (error) {
        logger.error('Failed to start Gmail MCP Server:', error);
        console.error('Failed to start Gmail MCP Server:', error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}
// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.log('Received SIGINT, shutting down gracefully...');
    process.exit(0);
});
process.on('SIGTERM', async () => {
    logger.log('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        logger.error('Unhandled error in main:', error);
        console.error('Error:', error);
        process.exit(1);
    });
}
