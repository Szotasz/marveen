import { gmailAuth } from './gmail-auth.js';
import { logger } from './api.js';
import * as fs from 'fs';
import * as path from 'path';
import mimeTypes from 'mime-types';
import { EnhancedSearchManager } from './enhanced-search.js';
import { ResilienceManager } from './error-handling-resilience.js';
import { PerformanceOptimizationManager } from './performance-optimization.js';
/**
 * Gmail operations manager class
 */
export class GmailOperations {
    constructor() {
        this.gmail = null;
        this.enhancedSearchManager = new EnhancedSearchManager(80); // Default 80% threshold
        this.resilienceManager = new ResilienceManager();
        this.performanceManager = new PerformanceOptimizationManager({ maxSize: 2000, ttlMs: 1800000 }, // 30 min cache
        { maxBatchSize: 50, batchTimeoutMs: 3000 }, // Optimized batch settings
        { maxConnections: 5, idleTimeoutMs: 300000 } // Connection pool
        );
    }
    /**
     * Reset cached Gmail client (called when authentication changes)
     */
    resetClient() {
        this.gmail = null;
    }
    /**
     * Get system status including resilience metrics
     */
    getSystemStatus() {
        return this.resilienceManager.getSystemStatus();
    }
    /**
     * Get performance metrics
     */
    getPerformanceMetrics() {
        return this.performanceManager.getPerformanceMetrics();
    }
    /**
     * Get authenticated Gmail client
     */
    async getGmailClient() {
        // Always get fresh client to handle re-authentication with different accounts
        this.gmail = await gmailAuth.getGmailClient();
        return this.gmail;
    }
    /**
     * Encode string to base64url
     */
    encodeBase64Url(str) {
        return Buffer.from(str)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');
    }
    /**
     * Decode base64url string
     */
    decodeBase64Url(str) {
        // Add padding if needed
        const padding = 4 - (str.length % 4);
        const paddedStr = str + '='.repeat(padding % 4);
        return Buffer.from(paddedStr.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    }
    /**
     * Create email message in RFC 2822 format
     */
    createRawMessage(message) {
        const lines = [];
        // Headers
        lines.push(`To: ${message.to.join(', ')}`);
        if (message.cc && message.cc.length > 0) {
            lines.push(`Cc: ${message.cc.join(', ')}`);
        }
        if (message.bcc && message.bcc.length > 0) {
            lines.push(`Bcc: ${message.bcc.join(', ')}`);
        }
        if (message.replyTo) {
            lines.push(`Reply-To: ${message.replyTo}`);
        }
        // Subject with proper encoding for international characters
        const encodedSubject = message.subject
            .replace(/[^\x00-\x7F]/g, (match) => `=?UTF-8?B?${Buffer.from(match).toString('base64')}?=`);
        lines.push(`Subject: ${encodedSubject}`);
        lines.push('MIME-Version: 1.0');
        if (message.attachments && message.attachments.length > 0) {
            // Multipart with attachments
            const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
            lines.push('');
            // Message body part
            lines.push(`--${boundary}`);
            if (message.html && message.text) {
                // Multipart alternative for HTML and text
                const altBoundary = `alt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
                lines.push('');
                lines.push(`--${altBoundary}`);
                lines.push('Content-Type: text/plain; charset=UTF-8');
                lines.push('Content-Transfer-Encoding: 8bit');
                lines.push('');
                lines.push(message.text);
                lines.push('');
                lines.push(`--${altBoundary}`);
                lines.push('Content-Type: text/html; charset=UTF-8');
                lines.push('Content-Transfer-Encoding: 8bit');
                lines.push('');
                lines.push(message.html);
                lines.push('');
                lines.push(`--${altBoundary}--`);
            }
            else {
                lines.push(`Content-Type: ${message.html ? 'text/html' : 'text/plain'}; charset=UTF-8`);
                lines.push('Content-Transfer-Encoding: 8bit');
                lines.push('');
                lines.push(message.html || message.text || '');
                lines.push('');
            }
            // Attachments
            for (const attachment of message.attachments) {
                lines.push(`--${boundary}`);
                const contentType = attachment.contentType || mimeTypes.lookup(attachment.filename) || 'application/octet-stream';
                lines.push(`Content-Type: ${contentType}`);
                lines.push('Content-Transfer-Encoding: base64');
                lines.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
                lines.push('');
                let content;
                if (Buffer.isBuffer(attachment.content)) {
                    // Already a Buffer - use directly
                    content = attachment.content;
                }
                else if (typeof attachment.content === 'string') {
                    // Check if it's a file path or base64 content
                    if (this.isFilePath(attachment.content)) {
                        // It's a file path - read the file
                        try {
                            content = fs.readFileSync(attachment.content);
                        }
                        catch (error) {
                            if (error.code === 'ENOENT') {
                                throw new Error(`Failed to read attachment file '${attachment.content}': File not found. Please provide the ABSOLUTE/FULL path to the file (e.g., '/Users/username/Documents/${attachment.filename}' or 'C:\\Users\\username\\Documents\\${attachment.filename}'). Relative paths like 'uploads/${attachment.filename}' will not work.`);
                            }
                            else {
                                throw new Error(`Failed to read attachment file '${attachment.content}': ${error}`);
                            }
                        }
                    }
                    else {
                        // It's base64 encoded content - decode it properly
                        try {
                            content = Buffer.from(attachment.content, 'base64');
                        }
                        catch (error) {
                            throw new Error(`Failed to decode base64 attachment '${attachment.filename}': ${error}`);
                        }
                    }
                }
                else {
                    throw new Error(`Invalid attachment content type for '${attachment.filename}'. Expected Buffer, base64 string, or file path.`);
                }
                // Convert to base64 for email transmission
                lines.push(content.toString('base64'));
                lines.push('');
            }
            lines.push(`--${boundary}--`);
        }
        else if (message.html && message.text) {
            // Multipart alternative for HTML and text
            const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
            lines.push('');
            lines.push(`--${boundary}`);
            lines.push('Content-Type: text/plain; charset=UTF-8');
            lines.push('Content-Transfer-Encoding: 8bit');
            lines.push('');
            lines.push(message.text);
            lines.push('');
            lines.push(`--${boundary}`);
            lines.push('Content-Type: text/html; charset=UTF-8');
            lines.push('Content-Transfer-Encoding: 8bit');
            lines.push('');
            lines.push(message.html);
            lines.push('');
            lines.push(`--${boundary}--`);
        }
        else {
            // Simple message
            lines.push(`Content-Type: ${message.html ? 'text/html' : 'text/plain'}; charset=UTF-8`);
            lines.push('Content-Transfer-Encoding: 8bit');
            lines.push('');
            lines.push(message.html || message.text || '');
        }
        return lines.join('\r\n');
    }
    /**
     * Send an email with resilience
     */
    async sendEmail(message, overrideClient) {
        return this.resilienceManager.executeResilientOperation(async () => {
            const gmail = overrideClient || await this.getGmailClient();
            const rawMessage = this.createRawMessage(message);
            const encodedMessage = this.encodeBase64Url(rawMessage);
            logger.log(`Sending email to: ${message.to.join(', ')}`);
            logger.log(`Subject: ${message.subject}`);
            const response = await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedMessage
                }
            });
            if (!response.data.id || !response.data.threadId) {
                throw new Error('Failed to send email: Invalid response from Gmail API');
            }
            logger.log(`Email sent successfully: ${response.data.id}`);
            return {
                id: response.data.id,
                threadId: response.data.threadId
            };
        }, 'send_email', {
            useCircuitBreaker: true,
            timeout: 15000, // 15 second timeout for sending
            customRetryConfig: {
                maxAttempts: 3,
                baseDelayMs: 2000
            }
        });
    }
    /**
     * Get email by ID with caching and batch optimization
     */
    async getEmail(messageId, format = 'full', overrideClient) {
        try {
            // Use cached version when possible
            const cacheKey = `email:${messageId}:${format}`;
            let cached = await this.performanceManager['cache'].get(cacheKey);
            if (!cached) {
                const gmail = overrideClient || await this.getGmailClient();
                logger.log(`Retrieving email: ${messageId}`);
                const response = await gmail.users.messages.get({
                    userId: 'me',
                    id: messageId,
                    format
                });
                cached = response.data;
                await this.performanceManager['cache'].set(cacheKey, cached, { compress: true, priority: 'normal' });
            }
            return cached;
        }
        catch (error) {
            logger.error('Error retrieving email:', error);
            throw new Error(`Failed to retrieve email: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Get email attachment
     */
    async getAttachment(messageId, attachmentId, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Retrieving attachment: ${attachmentId} from message: ${messageId}`);
            const response = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId,
                id: attachmentId
            });
            return {
                data: response.data.data,
                size: response.data.size
            };
        }
        catch (error) {
            logger.error('Error retrieving attachment:', error);
            throw new Error(`Failed to retrieve attachment: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Get email attachment and save to local file system
     * Converts base64 data to binary file and returns file path
     */
    async getAttachmentToLocal(messageId, attachmentId, customPath, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Downloading attachment to local: ${attachmentId} from message: ${messageId}`);
            // First, get the message to find available attachments
            const messageResponse = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full'
            });
            // Find all attachments in the message
            const attachments = this.findAllAttachments(messageResponse.data);
            if (attachments.length === 0) {
                throw new Error('No attachments found in this message');
            }
            logger.log(`Found ${attachments.length} attachments in message`);
            // If attachmentId is "0" or a number, treat it as an index
            let targetAttachment;
            if (/^\d+$/.test(attachmentId)) {
                const index = parseInt(attachmentId);
                if (index >= attachments.length) {
                    throw new Error(`Attachment index ${index} not found. Message has ${attachments.length} attachments (0-${attachments.length - 1})`);
                }
                targetAttachment = attachments[index];
                logger.log(`Using attachment at index ${index}: ${targetAttachment.filename}`);
            }
            else {
                // Find attachment by ID
                targetAttachment = attachments.find(att => att.attachmentId === attachmentId);
                if (!targetAttachment) {
                    const availableIds = attachments.map(att => att.attachmentId).join(', ');
                    throw new Error(`Attachment ID ${attachmentId} not found. Available IDs: ${availableIds}`);
                }
            }
            // Get attachment data using the correct attachment ID
            const attachmentResponse = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId,
                id: targetAttachment.attachmentId
            });
            // Create downloads directory if it doesn't exist
            const downloadsDir = customPath || path.resolve(process.cwd(), 'downloads');
            if (!fs.existsSync(downloadsDir)) {
                fs.mkdirSync(downloadsDir, { recursive: true });
            }
            // Generate unique filename with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const uniqueFilename = `${timestamp}_${targetAttachment.filename}`;
            const filePath = path.join(downloadsDir, uniqueFilename);
            // Decode base64 and save to file
            const base64Data = attachmentResponse.data.data;
            const binaryData = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(filePath, binaryData);
            logger.log(`Attachment saved to: ${filePath}`);
            return {
                filePath: path.resolve(filePath),
                filename: targetAttachment.filename,
                size: attachmentResponse.data.size,
                contentType: targetAttachment.contentType,
                fileUrl: `file://${path.resolve(filePath)}`
            };
        }
        catch (error) {
            logger.error('Error downloading attachment to local:', error);
            throw new Error(`Failed to download attachment to local: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Find all attachments in message payload
     */
    findAllAttachments(message) {
        const attachments = [];
        const findInParts = (parts) => {
            for (const part of parts) {
                if (part.body?.attachmentId && part.body.size && part.body.size > 0) {
                    const filename = this.extractFilename(part) || 'attachment';
                    const contentType = this.extractContentType(part) || 'application/octet-stream';
                    attachments.push({
                        attachmentId: part.body.attachmentId,
                        filename,
                        contentType,
                        size: part.body.size
                    });
                }
                if (part.parts) {
                    findInParts(part.parts);
                }
            }
        };
        if (message.payload?.parts) {
            findInParts(message.payload.parts);
        }
        return attachments;
    }
    /**
     * Find attachment part in message payload
     */
    findAttachmentPart(message, attachmentId) {
        const findInParts = (parts) => {
            for (const part of parts) {
                if (part.body?.attachmentId === attachmentId) {
                    return part;
                }
                if (part.parts) {
                    const found = findInParts(part.parts);
                    if (found)
                        return found;
                }
            }
            return null;
        };
        if (message.payload?.parts) {
            return findInParts(message.payload.parts);
        }
        return null;
    }
    /**
     * Extract filename from message part headers
     */
    extractFilename(part) {
        if (!part?.headers)
            return 'attachment';
        const contentDisposition = part.headers.find(h => h.name?.toLowerCase() === 'content-disposition');
        if (contentDisposition?.value) {
            const match = contentDisposition.value.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
            if (match) {
                return match[1].replace(/['"]/g, '');
            }
        }
        return 'attachment';
    }
    /**
     * Extract content type from message part headers
     */
    extractContentType(part) {
        if (!part?.headers)
            return 'application/octet-stream';
        const contentType = part.headers.find(h => h.name?.toLowerCase() === 'content-type');
        return contentType?.value || 'application/octet-stream';
    }
    /**
     * Check if a string is likely a file path
     */
    isFilePath(str) {
        // Check for common file path patterns
        // Unix/Linux/Mac paths starting with / or ./
        // Windows paths with drive letters or UNC paths
        // Relative paths
        const filePathPatterns = [
            /^\/[^\/]/, // Unix absolute path
            /^\.\//, // Relative path starting with ./
            /^\.\.\//, // Relative path starting with ../
            /^~\//, // Home directory path
            /^[A-Za-z]:[\\\/]/, // Windows drive letter
            /^\\\\/, // Windows UNC path
            /^[^\/\\]*\.[a-zA-Z0-9]{1,10}$/, // Simple filename with extension
            /[\/\\]/ // Contains path separators
        ];
        // Also check if it doesn't look like base64
        const isLikelyBase64 = /^[A-Za-z0-9+\/]+=*$/.test(str) && str.length % 4 === 0;
        // If it matches file path patterns and doesn't look like base64, it's probably a file path
        return filePathPatterns.some(pattern => pattern.test(str)) && !isLikelyBase64;
    }
    /**
     * List all attachments in a message
     */
    async listAttachments(messageId, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Listing attachments for message: ${messageId}`);
            const messageResponse = await gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full'
            });
            const attachments = this.findAllAttachments(messageResponse.data);
            return attachments.map((attachment, index) => ({
                index,
                ...attachment
            }));
        }
        catch (error) {
            logger.error('Error listing attachments:', error);
            throw new Error(`Failed to list attachments: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Enhanced search emails with natural language processing, fuzzy matching, resilience, and caching
     */
    async searchEmails(criteria = {}, overrideClient) {
        // Check cache first for search results
        return await this.performanceManager.getCachedSearchResults(criteria, async () => {
            // If enhanced search is requested or query looks like natural language
            if (criteria.useEnhancedSearch || this.isNaturalLanguageQuery(criteria.query || '')) {
                return this.resilienceManager.executeResilientOperation(() => this.performEnhancedSearch(criteria, overrideClient), 'enhanced_search', {
                    feature: 'enhanced_search',
                    fallback: () => this.performTraditionalSearch(criteria, overrideClient),
                    timeout: 20000, // 20 second timeout for enhanced search
                    customRetryConfig: {
                        maxAttempts: 2, // Fewer retries for search
                        baseDelayMs: 1000
                    }
                });
            }
            // Traditional search with basic resilience
            return this.resilienceManager.executeResilientOperation(() => this.performTraditionalSearch(criteria, overrideClient), 'traditional_search', {
                timeout: 10000, // 10 second timeout for basic search
                customRetryConfig: {
                    maxAttempts: 3,
                    baseDelayMs: 1000
                }
            });
        });
    }
    /**
     * Perform enhanced search with natural language processing
     */
    async performEnhancedSearch(criteria, overrideClient) {
        const gmail = overrideClient || await this.getGmailClient();
        // First, get a broader set of emails to search through
        const baseQuery = this.buildBaseQuery(criteria);
        logger.log(`Enhanced search - fetching emails with base query: ${baseQuery}`);
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: baseQuery,
            maxResults: Math.min(criteria.maxResults || 100, 500) // Get more emails for enhanced search
        });
        if (!response.data.messages) {
            return {
                messages: [],
                enhancedResults: {
                    structuredQuery: { text: criteria.query || '' },
                    searchResults: [],
                    crossReferences: []
                }
            };
        }
        // Get full message details for enhanced processing
        const allEmails = await Promise.all(response.data.messages.map(msg => this.getEmail(msg.id, 'metadata', overrideClient)));
        // Perform enhanced search
        const naturalQuery = criteria.query || '';
        const enhancedResults = await this.enhancedSearchManager.processNaturalLanguageQuery(naturalQuery, allEmails);
        // Convert enhanced results back to EmailInfo format
        const messages = enhancedResults.searchResults.map(result => result.email);
        // Limit results if specified
        const limitedMessages = criteria.maxResults ? messages.slice(0, criteria.maxResults) : messages;
        return {
            messages: limitedMessages,
            nextPageToken: response.data.nextPageToken || undefined,
            enhancedResults: criteria.includeCrossReferences !== false ? enhancedResults : undefined
        };
    }
    /**
     * Perform traditional Gmail search
     */
    async performTraditionalSearch(criteria, overrideClient) {
        const gmail = overrideClient || await this.getGmailClient();
        // Build search query
        const queryParts = [];
        if (criteria.query)
            queryParts.push(criteria.query);
        if (criteria.from)
            queryParts.push(`from:${criteria.from}`);
        if (criteria.to)
            queryParts.push(`to:${criteria.to}`);
        if (criteria.subject)
            queryParts.push(`subject:${criteria.subject}`);
        if (criteria.after)
            queryParts.push(`after:${criteria.after}`);
        if (criteria.before)
            queryParts.push(`before:${criteria.before}`);
        if (criteria.hasAttachment)
            queryParts.push('has:attachment');
        if (criteria.label)
            queryParts.push(`label:${criteria.label}`);
        if (criteria.isUnread)
            queryParts.push('is:unread');
        const query = queryParts.join(' ');
        logger.log(`Traditional search with query: ${query}`);
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults: criteria.maxResults || 100
        });
        if (!response.data.messages) {
            return { messages: [] };
        }
        // Get full message details
        const messages = await Promise.all(response.data.messages.map(msg => this.getEmail(msg.id, 'metadata', overrideClient)));
        return {
            messages,
            nextPageToken: response.data.nextPageToken || undefined
        };
    }
    /**
     * Build base query for enhanced search to get a broader set of emails
     */
    buildBaseQuery(criteria) {
        const queryParts = [];
        // Include basic filters that are always useful
        if (criteria.label)
            queryParts.push(`label:${criteria.label}`);
        if (criteria.after)
            queryParts.push(`after:${criteria.after}`);
        if (criteria.before)
            queryParts.push(`before:${criteria.before}`);
        if (criteria.hasAttachment)
            queryParts.push('has:attachment');
        if (criteria.isUnread)
            queryParts.push('is:unread');
        // Don't include the main query here - let enhanced search handle it
        return queryParts.join(' ');
    }
    /**
     * Detect if a query looks like natural language
     */
    isNaturalLanguageQuery(query) {
        if (!query)
            return false;
        const naturalLanguageIndicators = [
            // Time references
            /\b(few weeks ago|last week|last month|yesterday|today|this week|this month)\b/i,
            // Action words
            /\b(find|search|locate|get|retrieve|show me|look for)\b/i,
            // Context words
            /\b(about|regarding|concerning|related to|similar to)\b/i,
            // Entity patterns
            /\bPAN\s+[A-Z]{5}\d{4}[A-Z]\b/i,
            /\bDIN\s+[A-Z0-9]+\b/i,
            // Government references
            /\b(gov\.in|government|ministry|department|tax|income tax)\b/i
        ];
        return naturalLanguageIndicators.some(pattern => pattern.test(query));
    }
    /**
     * Mark email as read/unread
     */
    async markEmail(messageId, read, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Marking email ${messageId} as ${read ? 'read' : 'unread'}`);
            if (read) {
                await gmail.users.messages.modify({
                    userId: 'me',
                    id: messageId,
                    requestBody: {
                        removeLabelIds: ['UNREAD']
                    }
                });
            }
            else {
                await gmail.users.messages.modify({
                    userId: 'me',
                    id: messageId,
                    requestBody: {
                        addLabelIds: ['UNREAD']
                    }
                });
            }
        }
        catch (error) {
            logger.error('Error marking email:', error);
            throw new Error(`Failed to mark email: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Move email to label/folder
     */
    async moveToLabel(messageId, labelId, removeLabelIds, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Moving email ${messageId} to label ${labelId}`);
            await gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    addLabelIds: [labelId],
                    removeLabelIds: removeLabelIds || []
                }
            });
        }
        catch (error) {
            logger.error('Error moving email:', error);
            throw new Error(`Failed to move email: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Delete email
     */
    async deleteEmail(messageId, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Deleting email: ${messageId}`);
            await gmail.users.messages.delete({
                userId: 'me',
                id: messageId
            });
        }
        catch (error) {
            logger.error('Error deleting email:', error);
            throw new Error(`Failed to delete email: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Create a draft email
     */
    async createDraft(message, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            const rawMessage = this.createRawMessage(message);
            const encodedMessage = this.encodeBase64Url(rawMessage);
            logger.log(`Creating draft for: ${message.to.join(', ')}`);
            logger.log(`Subject: ${message.subject}`);
            const response = await gmail.users.drafts.create({
                userId: 'me',
                requestBody: {
                    message: {
                        raw: encodedMessage
                    }
                }
            });
            logger.log(`Draft created successfully: ${response.data.id}`);
            return {
                id: response.data.id,
                message: response.data.message
            };
        }
        catch (error) {
            logger.error('Error creating draft:', error);
            throw new Error(`Failed to create draft: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * List draft emails
     */
    async listDrafts(maxResults = 50, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log('Listing draft emails');
            const response = await gmail.users.drafts.list({
                userId: 'me',
                maxResults
            });
            if (!response.data.drafts) {
                return { drafts: [] };
            }
            // Get full draft details
            const drafts = await Promise.all(response.data.drafts.map(async (draft) => {
                const fullDraft = await this.getDraft(draft.id, overrideClient);
                return fullDraft;
            }));
            return {
                drafts,
                nextPageToken: response.data.nextPageToken || undefined
            };
        }
        catch (error) {
            logger.error('Error listing drafts:', error);
            throw new Error(`Failed to list drafts: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Get draft by ID
     */
    async getDraft(draftId, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Retrieving draft: ${draftId}`);
            const response = await gmail.users.drafts.get({
                userId: 'me',
                id: draftId
            });
            return {
                id: response.data.id,
                message: response.data.message
            };
        }
        catch (error) {
            logger.error('Error retrieving draft:', error);
            throw new Error(`Failed to retrieve draft: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Update draft email
     */
    async updateDraft(draftId, message, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            const rawMessage = this.createRawMessage(message);
            const encodedMessage = this.encodeBase64Url(rawMessage);
            logger.log(`Updating draft: ${draftId}`);
            logger.log(`Subject: ${message.subject}`);
            const response = await gmail.users.drafts.update({
                userId: 'me',
                id: draftId,
                requestBody: {
                    message: {
                        raw: encodedMessage
                    }
                }
            });
            logger.log(`Draft updated successfully: ${response.data.id}`);
            return {
                id: response.data.id,
                message: response.data.message
            };
        }
        catch (error) {
            logger.error('Error updating draft:', error);
            throw new Error(`Failed to update draft: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Delete draft email
     */
    async deleteDraft(draftId, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Deleting draft: ${draftId}`);
            await gmail.users.drafts.delete({
                userId: 'me',
                id: draftId
            });
            logger.log(`Draft deleted successfully: ${draftId}`);
        }
        catch (error) {
            logger.error('Error deleting draft:', error);
            throw new Error(`Failed to delete draft: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Send draft email
     */
    async sendDraft(draftId, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Sending draft: ${draftId}`);
            const response = await gmail.users.drafts.send({
                userId: 'me',
                requestBody: {
                    id: draftId
                }
            });
            logger.log(`Draft sent successfully: ${response.data.id}`);
            return {
                id: response.data.id,
                threadId: response.data.threadId
            };
        }
        catch (error) {
            logger.error('Error sending draft:', error);
            throw new Error(`Failed to send draft: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * List emails in inbox, sent, or custom label
     */
    async listEmails(labelId = 'INBOX', maxResults = 50, overrideClient) {
        try {
            const gmail = overrideClient || await this.getGmailClient();
            logger.log(`Listing emails in label: ${labelId}`);
            const response = await gmail.users.messages.list({
                userId: 'me',
                labelIds: [labelId],
                maxResults
            });
            if (!response.data.messages) {
                return { messages: [] };
            }
            // Get message details
            const messages = await Promise.all(response.data.messages.map(msg => this.getEmail(msg.id, 'metadata', overrideClient)));
            return {
                messages,
                nextPageToken: response.data.nextPageToken || undefined
            };
        }
        catch (error) {
            logger.error('Error listing emails:', error);
            throw new Error(`Failed to list emails: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
    /**
     * Extract email content from payload
     */
    extractEmailContent(payload) {
        const result = { attachments: [] };
        const extractParts = (parts) => {
            for (const part of parts) {
                if (part.parts) {
                    extractParts(part.parts);
                }
                else if (part.body && part.body.data) {
                    const mimeType = part.mimeType;
                    const data = this.decodeBase64Url(part.body.data);
                    if (mimeType === 'text/plain') {
                        result.text = data;
                    }
                    else if (mimeType === 'text/html') {
                        result.html = data;
                    }
                }
                // Handle attachments
                if (part.filename && part.body && (part.body.attachmentId || part.body.data)) {
                    result.attachments.push({
                        filename: part.filename,
                        mimeType: part.mimeType,
                        size: part.body.size,
                        attachmentId: part.body.attachmentId
                    });
                }
            }
        };
        if (payload.parts) {
            extractParts(payload.parts);
        }
        else if (payload.body && payload.body.data) {
            const mimeType = payload.mimeType;
            const data = this.decodeBase64Url(payload.body.data);
            if (mimeType === 'text/plain') {
                result.text = data;
            }
            else if (mimeType === 'text/html') {
                result.html = data;
            }
        }
        return result;
    }
}
// Export singleton instance
export const gmailOperations = new GmailOperations();
