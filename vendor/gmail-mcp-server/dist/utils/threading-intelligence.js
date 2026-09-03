/**
 * Threading & Intelligence Utilities for Gmail MCP
 * - Thread reconstruction (including forwards/replies)
 * - Conversation context extraction
 * - Email classification & urgency detection
 * - Proactive alert/reminder suggestion
 */
export class ThreadReconstructor {
    /**
     * Reconstructs a conversation thread given an email and all emails
     */
    reconstructConversation(emailId, allEmails) {
        // Find the target email
        const target = allEmails.find(e => e.id === emailId);
        if (!target)
            return [];
        // Strategy 1: Use threadId
        const threadEmails = allEmails.filter(e => e.threadId === target.threadId);
        // Strategy 2: Subject line analysis (Re:, Fwd:)
        const baseSubject = this.normalizeSubject(target.subject);
        const subjectRelated = allEmails.filter(e => this.normalizeSubject(e.subject) === baseSubject);
        // Strategy 3: Content analysis for forwarded emails
        const forwarded = allEmails.filter(e => this.containsForwardedContent(e.snippet || ''));
        // Merge and deduplicate
        const allRelated = [...threadEmails, ...subjectRelated, ...forwarded];
        const unique = Object.values(allRelated.reduce((acc, e) => { acc[e.id] = e; return acc; }, {}));
        // Sort chronologically
        return unique.sort((a, b) => (new Date(a.internalDate).getTime() - new Date(b.internalDate).getTime()));
    }
    normalizeSubject(subject) {
        return subject.replace(/^(re:|fwd:|fw:)/i, '').trim().toLowerCase();
    }
    containsForwardedContent(content) {
        const patterns = [
            /Begin forwarded message:/i,
            /---------- Forwarded message ---------/i,
            /From:.*?Date:.*?Subject:/is
        ];
        return patterns.some(p => p.test(content));
    }
}
export class ConversationManager {
    /**
     * Extracts context for a conversation thread
     */
    async preserveContext(emails) {
        const sorted = emails.sort((a, b) => (new Date(a.internalDate).getTime() - new Date(b.internalDate).getTime()));
        const participants = Array.from(new Set(sorted.flatMap(e => this.extractParticipants(e))));
        const timeline = sorted.map(e => ({ id: e.id, date: new Date(e.internalDate), subject: e.subject }));
        const topics = this.extractTopics(sorted);
        const references = this.extractReferences(sorted);
        const metadata = {
            totalMessages: sorted.length,
            duration: this.calculateDuration(sorted),
            lastActivity: new Date(sorted[sorted.length - 1].internalDate)
        };
        return {
            threadId: sorted[0].threadId,
            participants,
            timeline,
            topics,
            references,
            metadata
        };
    }
    extractParticipants(email) {
        const headers = email.payload?.headers || [];
        const from = headers.find((h) => h.name === 'From')?.value;
        const to = headers.find((h) => h.name === 'To')?.value;
        const cc = headers.find((h) => h.name === 'Cc')?.value;
        return [from, ...(to ? to.split(',') : []), ...(cc ? cc.split(',') : [])].filter(Boolean).map(s => s.trim());
    }
    extractTopics(emails) {
        // Simple keyword extraction from subjects
        const allSubjects = emails.map(e => e.subject).join(' ');
        const keywords = allSubjects.match(/\b\w{5,}\b/g) || [];
        return Array.from(new Set(keywords.map(w => w.toLowerCase()))).slice(0, 10);
    }
    extractReferences(emails) {
        // Find URLs, document names, and attachment names
        const urls = [];
        const docs = [];
        const attachments = [];
        for (const e of emails) {
            const content = e.snippet || '';
            const urlMatches = content.match(/https?:\/\/\S+/g) || [];
            urls.push(...urlMatches);
            // Simulate document/attachment extraction
            if (content.match(/pdf|docx|xls|statement|notice|assessment/i)) {
                docs.push(e.subject);
            }
            if (e.payload?.parts) {
                for (const part of e.payload.parts) {
                    if (part.filename)
                        attachments.push(part.filename);
                }
            }
        }
        return {
            documents: Array.from(new Set(docs)),
            urls: Array.from(new Set(urls)),
            attachments: Array.from(new Set(attachments))
        };
    }
    calculateDuration(emails) {
        if (emails.length < 2)
            return '0 days';
        const start = new Date(emails[0].internalDate).getTime();
        const end = new Date(emails[emails.length - 1].internalDate).getTime();
        const days = Math.round((end - start) / (1000 * 60 * 60 * 24));
        return `${days} days`;
    }
}
export class EmailIntelligence {
    constructor() {
        this.governmentDomains = [
            'insight.gov.in', 'incometax.gov.in', 'cbdt.gov.in',
            'gst.gov.in', 'rbi.org.in'
        ];
        this.urgencyKeywords = [
            'final opportunity', 'last chance', 'immediate action',
            'deadline', 'penalty', 'legal action', 'compliance'
        ];
        this.legalKeywords = [
            'notice', 'assessment', 'compliance', 'section', 'act'
        ];
    }
    classifyEmail(email) {
        let score = 0;
        let category = 'GENERAL';
        let reason = '';
        const from = email.payload?.headers?.find((h) => h.name === 'From')?.value || '';
        const content = `${email.subject} ${email.snippet}`.toLowerCase();
        // Government sender
        if (this.governmentDomains.some(domain => from.includes(domain))) {
            score += 50;
            category = 'GOVERNMENT';
            reason += 'Government sender. ';
        }
        // Urgency
        const urgencyMatches = this.urgencyKeywords.filter(kw => content.includes(kw));
        score += urgencyMatches.length * 20;
        if (urgencyMatches.length)
            reason += `Urgency: ${urgencyMatches.join(', ')}. `;
        // Legal/tax
        const legalMatches = this.legalKeywords.filter(kw => content.includes(kw));
        score += legalMatches.length * 10;
        if (legalMatches.length)
            reason += `Legal: ${legalMatches.join(', ')}. `;
        // Set importance
        let importance = 'LOW';
        let actionRequired = false;
        if (score >= 70) {
            importance = 'CRITICAL';
            actionRequired = true;
        }
        else if (score >= 40) {
            importance = 'HIGH';
        }
        // Extract deadline (simple pattern)
        const deadlineMatch = content.match(/by (\d{1,2} [a-zA-Z]+ \d{4})/);
        let deadline = null;
        if (deadlineMatch) {
            deadline = new Date(deadlineMatch[1]);
            reason += `Deadline detected: ${deadlineMatch[1]}. `;
        }
        // Related docs
        const relatedDocs = content.match(/PAN [A-Z]{5}\d{4}[A-Z]/g) || [];
        return {
            importance,
            category,
            actionRequired,
            deadline,
            relatedDocuments: relatedDocs,
            detectedEntities: relatedDocs,
            reason: reason.trim()
        };
    }
}
export class ProactiveReminderSystem {
    /**
     * Suggests reminders for important emails (e.g., deadlines)
     */
    createSmartReminders(email, classification) {
        const reminders = [];
        if (classification.category === 'GOVERNMENT' && classification.deadline) {
            // 7 days before
            reminders.push({
                reminderDate: new Date(classification.deadline.getTime() - 7 * 24 * 60 * 60 * 1000),
                type: 'DEADLINE',
                context: { originalDeadline: classification.deadline }
            });
            // 1 day before
            reminders.push({
                reminderDate: new Date(classification.deadline.getTime() - 24 * 60 * 60 * 1000),
                type: 'DEADLINE',
                context: { originalDeadline: classification.deadline }
            });
        }
        return reminders;
    }
}
