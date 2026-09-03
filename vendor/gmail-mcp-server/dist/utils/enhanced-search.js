/**
 * Enhanced Gmail Search Implementation
 * Provides natural language query parsing, fuzzy matching, and cross-reference detection
 */
import { logger } from './api.js';
/**
 * Natural Language Query Parser
 * Converts natural language queries into structured search criteria
 */
export class NLQueryParser {
    constructor() {
        this.timePatterns = {
            relative: {
                'few weeks ago': () => ({ start: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000), end: new Date() }),
                'last week': () => ({ start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), end: new Date() }),
                'last month': () => ({ start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), end: new Date() }),
                'yesterday': () => ({ start: new Date(Date.now() - 24 * 60 * 60 * 1000), end: new Date() }),
                'today': () => ({ start: new Date(), end: new Date() }),
                'this week': () => ({ start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), end: new Date() }),
                'this month': () => ({ start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), end: new Date() })
            },
            absolute: /(?:from|since|after)\s+(\w+\s+\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})/gi
        };
        this.entityPatterns = {
            pan: /PAN\s+([A-Z]{5}\d{4}[A-Z])/gi,
            din: /DIN\s+([A-Z0-9]+)/gi,
            amount: /(?:Rs\.?|₹|INR)\s*(\d+(?:,\d{3})*(?:\.\d{2})?)/gi,
            email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,
            government: /(?:gov\.in|government|ministry|department)/gi
        };
        this.intentKeywords = {
            find_document: ['find', 'search', 'locate', 'get', 'retrieve'],
            check_status: ['status', 'check', 'verify', 'confirm'],
            find_related: ['related', 'similar', 'same', 'connected', 'thread'],
            summarize: ['summarize', 'summary', 'overview', 'brief']
        };
    }
    parseQuery(naturalQuery) {
        const query = naturalQuery.toLowerCase();
        const result = { text: naturalQuery };
        // Extract time references
        result.dateRange = this.extractTimeRange(query);
        // Extract entities
        result.entities = this.extractEntities(naturalQuery);
        // Extract sender information
        result.sender = this.extractSenders(naturalQuery);
        // Extract subject keywords
        result.subject = this.extractSubjectKeywords(naturalQuery);
        // Detect intent
        result.intent = this.detectIntent(query);
        // Extract attachment requirements
        result.hasAttachment = this.extractAttachmentRequirement(query);
        // Extract label/folder requirements
        result.labels = this.extractLabels(query);
        return result;
    }
    extractTimeRange(query) {
        // Check relative time patterns first
        for (const [pattern, handler] of Object.entries(this.timePatterns.relative)) {
            if (query.includes(pattern)) {
                return handler();
            }
        }
        // Check for month names with "from"
        const monthPattern = /(?:from|in)\s+(\w+)/gi;
        const monthMatch = monthPattern.exec(query);
        if (monthMatch) {
            const monthName = monthMatch[1].toLowerCase();
            const monthNum = this.getMonthNumber(monthName);
            if (monthNum >= 0) {
                const year = new Date().getFullYear();
                const start = new Date(year, monthNum, 1);
                const end = new Date(year, monthNum + 1, 0); // Last day of month
                return { start, end };
            }
        }
        // Check absolute date patterns
        const absoluteMatch = this.timePatterns.absolute.exec(query);
        if (absoluteMatch) {
            const dateStr = absoluteMatch[1];
            const date = this.parseDate(dateStr);
            if (date) {
                return { start: date, end: new Date() };
            }
        }
        return undefined;
    }
    extractEntities(text) {
        const entities = {};
        // Extract PAN numbers
        const panMatches = text.match(this.entityPatterns.pan);
        if (panMatches) {
            entities.panNumbers = panMatches.map(match => match.replace('PAN ', ''));
        }
        // Extract DIN numbers
        const dinMatches = text.match(this.entityPatterns.din);
        if (dinMatches) {
            entities.dinNumbers = dinMatches.map(match => match.replace('DIN ', ''));
        }
        // Extract amounts
        const amountMatches = text.match(this.entityPatterns.amount);
        if (amountMatches) {
            entities.amounts = amountMatches.map(match => {
                const amount = match.replace(/[^\d.,]/g, '').replace(',', '');
                return parseFloat(amount);
            });
        }
        // Extract email addresses
        const emailMatches = text.match(this.entityPatterns.email);
        if (emailMatches) {
            entities.organizations = emailMatches.map(email => email.split('@')[1]);
        }
        // Extract government references
        const govMatches = text.match(this.entityPatterns.government);
        if (govMatches) {
            entities.organizations = entities.organizations || [];
            entities.organizations.push('government');
        }
        return entities;
    }
    extractSenders(query) {
        const senderPatterns = [
            /(?:from|by)\s+([^\s,]+@[^\s,]+)/gi,
            /(?:from|by)\s+([^\s,]+\.gov\.in)/gi,
            /(?:from|by)\s+([^\s,]+\.com)/gi
        ];
        const senders = [];
        for (const pattern of senderPatterns) {
            const matches = query.match(pattern);
            if (matches) {
                senders.push(...matches.map(match => match.replace(/(?:from|by)\s+/, '')));
            }
        }
        return senders;
    }
    extractSubjectKeywords(query) {
        const subjectPatterns = [
            /(?:subject|about|regarding)\s+"([^"]+)"/gi,
            /(?:subject|about|regarding)\s+([^\s]+)/gi
        ];
        for (const pattern of subjectPatterns) {
            const match = pattern.exec(query);
            if (match) {
                return match[1];
            }
        }
        return undefined;
    }
    detectIntent(query) {
        for (const [intent, keywords] of Object.entries(this.intentKeywords)) {
            if (keywords.some(keyword => query.includes(keyword))) {
                return intent;
            }
        }
        return 'general';
    }
    extractAttachmentRequirement(query) {
        const attachmentKeywords = ['attachment', 'file', 'document', 'pdf', 'attached'];
        return attachmentKeywords.some(keyword => query.includes(keyword));
    }
    extractLabels(query) {
        const labelKeywords = {
            'inbox': 'INBOX',
            'sent': 'SENT',
            'draft': 'DRAFT',
            'trash': 'TRASH',
            'spam': 'SPAM',
            'archive': 'INBOX' // Archive is typically in INBOX
        };
        const labels = [];
        for (const [keyword, label] of Object.entries(labelKeywords)) {
            if (query.includes(keyword)) {
                labels.push(label);
            }
        }
        return labels;
    }
    parseDate(dateStr) {
        try {
            // Try various date formats
            const formats = [
                /(\w+)\s+(\d{1,2})/, // "May 15"
                /(\d{1,2})\/(\d{1,2})\/(\d{4})/, // "15/05/2024"
                /(\d{1,2})-(\d{1,2})-(\d{4})/ // "15-05-2024"
            ];
            for (const format of formats) {
                const match = dateStr.match(format);
                if (match) {
                    if (match.length === 3) {
                        // Month name + day
                        const month = this.getMonthNumber(match[1]);
                        const day = parseInt(match[2]);
                        const year = new Date().getFullYear();
                        return new Date(year, month, day);
                    }
                    else if (match.length === 4) {
                        // DD/MM/YYYY or DD-MM-YYYY
                        const day = parseInt(match[1]);
                        const month = parseInt(match[2]) - 1;
                        const year = parseInt(match[3]);
                        return new Date(year, month, day);
                    }
                }
            }
        }
        catch (error) {
            logger.error('Error parsing date:', error);
        }
        return null;
    }
    getMonthNumber(monthName) {
        const months = {
            'january': 0, 'jan': 0,
            'february': 1, 'feb': 1,
            'march': 2, 'mar': 2,
            'april': 3, 'apr': 3,
            'may': 4,
            'june': 5, 'jun': 5,
            'july': 6, 'jul': 6,
            'august': 7, 'aug': 7,
            'september': 8, 'sep': 8, 'sept': 8,
            'october': 9, 'oct': 9,
            'november': 10, 'nov': 10,
            'december': 11, 'dec': 11
        };
        const month = months[monthName.toLowerCase()];
        return month !== undefined ? month : -1;
    }
}
/**
 * Fuzzy Matching Engine
 * Provides intelligent matching with similarity scoring
 */
export class FuzzyMatcher {
    constructor(threshold = 80) {
        this.similarityThreshold = threshold;
    }
    calculateSimilarity(str1, str2) {
        const s1 = str1.toLowerCase();
        const s2 = str2.toLowerCase();
        // Exact match
        if (s1 === s2)
            return 100;
        // Substring match
        if (s1.includes(s2) || s2.includes(s1))
            return 95;
        // Word-level matching
        const words1 = s1.split(/\s+/);
        const words2 = s2.split(/\s+/);
        const commonWords = words1.filter(word => words2.includes(word));
        const totalWords = Math.max(words1.length, words2.length);
        if (totalWords === 0)
            return 0;
        const wordSimilarity = (commonWords.length / totalWords) * 100;
        // Character-level similarity (simple implementation)
        const charSimilarity = this.calculateCharacterSimilarity(s1, s2);
        // Weighted combination
        return (wordSimilarity * 0.7) + (charSimilarity * 0.3);
    }
    calculateCharacterSimilarity(str1, str2) {
        const len1 = str1.length;
        const len2 = str2.length;
        if (len1 === 0 && len2 === 0)
            return 100;
        if (len1 === 0 || len2 === 0)
            return 0;
        const matrix = [];
        // Initialize matrix
        for (let i = 0; i <= len1; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= len2; j++) {
            matrix[0][j] = j;
        }
        // Fill matrix
        for (let i = 1; i <= len1; i++) {
            for (let j = 1; j <= len2; j++) {
                const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(matrix[i - 1][j] + 1, // deletion
                matrix[i][j - 1] + 1, // insertion
                matrix[i - 1][j - 1] + cost // substitution
                );
            }
        }
        const distance = matrix[len1][len2];
        const maxLen = Math.max(len1, len2);
        return maxLen === 0 ? 100 : ((maxLen - distance) / maxLen) * 100;
    }
    findMatches(query, emails) {
        const results = [];
        for (const email of emails) {
            const fieldsToSearch = [
                email.subject || '',
                email.snippet || '',
                this.extractSender(email) || '',
                this.extractContent(email) || ''
            ];
            let bestScore = 0;
            let bestField = '';
            for (const field of fieldsToSearch) {
                const similarity = this.calculateSimilarity(query, field);
                if (similarity > bestScore) {
                    bestScore = similarity;
                    bestField = field;
                }
            }
            if (bestScore >= this.similarityThreshold) {
                results.push({
                    email,
                    matchScore: bestScore,
                    matchedField: bestField,
                    relevance: this.getRelevanceLevel(bestScore),
                    crossReferences: this.findCrossReferences(email, emails)
                });
            }
        }
        // Sort by relevance score
        return results.sort((a, b) => b.matchScore - a.matchScore);
    }
    extractSender(email) {
        if (email.payload?.headers) {
            const fromHeader = email.payload.headers.find((h) => h.name === 'From');
            return fromHeader?.value || '';
        }
        return '';
    }
    extractContent(email) {
        if (email.payload?.body?.data) {
            return this.decodeBase64Url(email.payload.body.data);
        }
        return '';
    }
    decodeBase64Url(str) {
        try {
            return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        }
        catch {
            return '';
        }
    }
    getRelevanceLevel(score) {
        if (score >= 95)
            return 'exact';
        if (score >= 85)
            return 'high';
        if (score >= 70)
            return 'medium';
        return 'low';
    }
    findCrossReferences(email, allEmails) {
        const references = [];
        // Same thread
        const threadEmails = allEmails.filter(e => e.threadId === email.threadId);
        if (threadEmails.length > 1) {
            references.push(...threadEmails.map(e => e.id).filter(id => id !== email.id));
        }
        // Same sender
        const sender = this.extractSender(email);
        if (sender) {
            const senderEmails = allEmails.filter(e => e.id !== email.id && this.extractSender(e) === sender);
            references.push(...senderEmails.map(e => e.id));
        }
        return references.slice(0, 5); // Limit to 5 references
    }
}
/**
 * Cross-Reference Detection Engine
 * Finds related emails based on various criteria
 */
export class CrossReferenceEngine {
    async findRelatedEmails(email, allEmails) {
        const related = [];
        // Extract entities from the email
        const entities = this.extractEntities(email);
        // Find emails with same entities
        for (const otherEmail of allEmails) {
            if (otherEmail.id === email.id)
                continue;
            const otherEntities = this.extractEntities(otherEmail);
            const relationship = this.findRelationship(email, otherEmail, entities, otherEntities);
            if (relationship) {
                related.push(relationship);
            }
        }
        // Sort by confidence and limit results
        return related
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 10);
    }
    extractEntities(email) {
        const content = `${email.subject || ''} ${email.snippet || ''}`;
        return {
            panNumbers: this.extractPANNumbers(content),
            dinNumbers: this.extractDINNumbers(content),
            amounts: this.extractAmounts(content),
            organizations: this.extractOrganizations(content),
            dates: this.extractDates(content)
        };
    }
    extractPANNumbers(text) {
        const panRegex = /[A-Z]{5}\d{4}[A-Z]/g;
        return text.match(panRegex) || [];
    }
    extractDINNumbers(text) {
        const dinRegex = /DIN\s*([A-Z0-9]+)/gi;
        const matches = text.match(dinRegex) || [];
        return matches.map(match => match.replace(/DIN\s*/i, ''));
    }
    extractAmounts(text) {
        const amountRegex = /(?:Rs\.?|₹|INR)\s*(\d+(?:,\d{3})*(?:\.\d{2})?)/gi;
        const matches = text.match(amountRegex) || [];
        return matches.map(match => {
            const amount = match.replace(/[^\d.,]/g, '').replace(',', '');
            return parseFloat(amount);
        });
    }
    extractOrganizations(text) {
        const orgRegex = /(?:from|by)\s+([^\s,]+@[^\s,]+)/gi;
        const matches = text.match(orgRegex) || [];
        return matches.map(match => match.replace(/(?:from|by)\s+/, ''));
    }
    extractDates(text) {
        const dateRegex = /(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}-\d{1,2}-\d{4})/g;
        const matches = text.match(dateRegex) || [];
        return matches.map(match => new Date(match)).filter(date => !isNaN(date.getTime()));
    }
    findRelationship(email1, email2, entities1, entities2) {
        let confidence = 0;
        let relationship = 'same_topic';
        let reason = '';
        // Same thread relationship
        if (email1.threadId === email2.threadId) {
            return {
                emailId: email2.id,
                relationship: 'same_thread',
                confidence: 100,
                reason: 'Same conversation thread'
            };
        }
        // Same sender relationship
        const sender1 = this.extractSender(email1);
        const sender2 = this.extractSender(email2);
        if (sender1 && sender1 === sender2) {
            confidence = 90;
            relationship = 'same_sender';
            reason = 'Same sender';
        }
        // Entity-based relationships
        const entityMatches = this.findEntityMatches(entities1, entities2);
        if (entityMatches.length > 0) {
            confidence = Math.max(confidence, 80);
            relationship = 'same_entity';
            reason = `Shared entities: ${entityMatches.join(', ')}`;
        }
        // Topic similarity
        const topicSimilarity = this.calculateTopicSimilarity(email1, email2);
        if (topicSimilarity > 70) {
            confidence = Math.max(confidence, topicSimilarity);
            relationship = 'same_topic';
            reason = `Similar topic (${topicSimilarity}% match)`;
        }
        return confidence > 50 ? {
            emailId: email2.id,
            relationship,
            confidence,
            reason
        } : null;
    }
    extractSender(email) {
        if (email.payload?.headers) {
            const fromHeader = email.payload.headers.find((h) => h.name === 'From');
            return fromHeader?.value || '';
        }
        return '';
    }
    findEntityMatches(entities1, entities2) {
        const matches = [];
        // PAN number matches
        const panMatches = entities1.panNumbers?.filter((pan) => entities2.panNumbers?.includes(pan)) || [];
        if (panMatches.length > 0) {
            matches.push(`PAN: ${panMatches.join(', ')}`);
        }
        // DIN number matches
        const dinMatches = entities1.dinNumbers?.filter((din) => entities2.dinNumbers?.includes(din)) || [];
        if (dinMatches.length > 0) {
            matches.push(`DIN: ${dinMatches.join(', ')}`);
        }
        // Organization matches
        const orgMatches = entities1.organizations?.filter((org) => entities2.organizations?.includes(org)) || [];
        if (orgMatches.length > 0) {
            matches.push(`Organization: ${orgMatches.join(', ')}`);
        }
        return matches;
    }
    calculateTopicSimilarity(email1, email2) {
        const content1 = `${email1.subject || ''} ${email1.snippet || ''}`.toLowerCase();
        const content2 = `${email2.subject || ''} ${email2.snippet || ''}`.toLowerCase();
        const words1 = content1.split(/\s+/);
        const words2 = content2.split(/\s+/);
        const commonWords = words1.filter(word => word.length > 3 && words2.includes(word));
        const totalWords = Math.max(words1.length, words2.length);
        return totalWords === 0 ? 0 : (commonWords.length / totalWords) * 100;
    }
}
/**
 * Enhanced Search Manager
 * Combines all enhanced search capabilities
 */
export class EnhancedSearchManager {
    constructor(fuzzyThreshold = 80) {
        this.nlParser = new NLQueryParser();
        this.fuzzyMatcher = new FuzzyMatcher(fuzzyThreshold);
        this.crossReferenceEngine = new CrossReferenceEngine();
    }
    async processNaturalLanguageQuery(naturalQuery, emails) {
        // Parse natural language query
        const structuredQuery = this.nlParser.parseQuery(naturalQuery);
        // Perform fuzzy matching
        const searchResults = this.fuzzyMatcher.findMatches(naturalQuery, emails);
        // Find cross-references for top results
        const crossReferences = [];
        for (const result of searchResults.slice(0, 5)) {
            const references = await this.crossReferenceEngine.findRelatedEmails(result.email, emails);
            crossReferences.push(...references);
        }
        return {
            structuredQuery,
            searchResults,
            crossReferences: this.deduplicateCrossReferences(crossReferences)
        };
    }
    deduplicateCrossReferences(references) {
        const seen = new Set();
        return references.filter(ref => {
            if (seen.has(ref.emailId)) {
                return false;
            }
            seen.add(ref.emailId);
            return true;
        });
    }
}
