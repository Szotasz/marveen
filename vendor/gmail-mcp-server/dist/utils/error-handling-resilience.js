/**
 * Error Handling & Resilience System
 * Provides comprehensive error handling, retry mechanisms, circuit breakers, and graceful degradation
 */
import { logger } from './api.js';
export class ResilientError extends Error {
    constructor(message, errorType, retryable = false, context) {
        super(message);
        this.errorType = errorType;
        this.retryable = retryable;
        this.context = context;
        this.name = 'ResilientError';
    }
}
/**
 * Exponential Backoff Retry Manager
 */
export class RetryManager {
    constructor(config = {}) {
        this.config = {
            maxAttempts: 3,
            baseDelayMs: 1000,
            maxDelayMs: 30000,
            backoffMultiplier: 2,
            jitterPercent: 10,
            ...config
        };
    }
    async executeWithRetry(operation, operationName, customConfig) {
        const config = { ...this.config, ...customConfig };
        let lastError;
        const startTime = Date.now();
        for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
            try {
                logger.log(`Attempt ${attempt}/${config.maxAttempts} for operation: ${operationName}`);
                const result = await operation();
                if (attempt > 1) {
                    logger.log(`Operation ${operationName} succeeded on attempt ${attempt}`);
                }
                return result;
            }
            catch (error) {
                lastError = error;
                const errorType = this.classifyError(error);
                const retryable = this.isRetryable(errorType, error);
                const context = {
                    operation: operationName,
                    attempt,
                    totalTime: Date.now() - startTime,
                    errorType,
                    retryable,
                    metadata: { originalError: error }
                };
                logger.error(`Attempt ${attempt}/${config.maxAttempts} failed for ${operationName}:`, error);
                // If not retryable or last attempt, throw enhanced error
                if (!retryable || attempt === config.maxAttempts) {
                    throw new ResilientError(`Operation ${operationName} failed after ${attempt} attempts: ${lastError.message}`, errorType, retryable, context);
                }
                // Wait before retry with exponential backoff and jitter
                if (attempt < config.maxAttempts) {
                    const delay = this.calculateDelay(attempt, config);
                    logger.log(`Waiting ${delay}ms before retry ${attempt + 1}`);
                    await this.sleep(delay);
                }
            }
        }
        // This shouldn't be reached, but TypeScript requires it
        throw lastError;
    }
    classifyError(error) {
        const message = error?.message?.toLowerCase() || '';
        const status = error?.status || error?.response?.status;
        // Rate limiting
        if (status === 429 || message.includes('rate limit') || message.includes('quota exceeded')) {
            return 'RATE_LIMITED';
        }
        // Authentication
        if (status === 401 || status === 403 || message.includes('unauthorized') || message.includes('forbidden')) {
            return 'AUTHENTICATION_ERROR';
        }
        // Network errors
        if (message.includes('network') || message.includes('timeout') || message.includes('enotfound')) {
            return 'NETWORK_ERROR';
        }
        // Timeout errors
        if (message.includes('timeout') || error?.code === 'ETIMEDOUT') {
            return 'TIMEOUT_ERROR';
        }
        // API errors - both client (4xx) and server (5xx) errors
        if (status >= 400) {
            return 'API_ERROR';
        }
        // Parsing errors
        if (message.includes('parse') || message.includes('json') || message.includes('syntax')) {
            return 'PARSING_ERROR';
        }
        return 'UNKNOWN_ERROR';
    }
    isRetryable(errorType, error) {
        switch (errorType) {
            case 'RATE_LIMITED':
            case 'NETWORK_ERROR':
            case 'TIMEOUT_ERROR':
                return true;
            case 'AUTHENTICATION_ERROR':
                return false; // Don't retry auth errors
            case 'API_ERROR':
                const status = error?.status || error?.response?.status;
                return status >= 500; // Retry server errors, not client errors
            case 'PARSING_ERROR':
                return false; // Don't retry parsing errors
            case 'UNKNOWN_ERROR':
                return true; // Be optimistic about unknown errors
            default:
                return false;
        }
    }
    calculateDelay(attempt, config) {
        // Exponential backoff: baseDelay * multiplier^(attempt-1)
        let delay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1);
        // Cap at maxDelay
        delay = Math.min(delay, config.maxDelayMs);
        // Add jitter to prevent thundering herd
        const jitter = delay * (config.jitterPercent / 100) * Math.random();
        delay = delay + jitter;
        return Math.round(delay);
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
/**
 * Circuit Breaker Pattern Implementation
 */
export class CircuitBreaker {
    constructor(config = {}) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = 0;
        this.config = {
            failureThreshold: 5,
            recoveryTimeoutMs: 60000,
            monitoringWindowMs: 300000,
            ...config
        };
    }
    async execute(operation, operationName) {
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime < this.config.recoveryTimeoutMs) {
                throw new ResilientError(`Circuit breaker is OPEN for ${operationName}. Failing fast.`, 'API_ERROR', false);
            }
            else {
                this.state = 'HALF_OPEN';
                this.successCount = 0;
                logger.log(`Circuit breaker for ${operationName} moving to HALF_OPEN state`);
            }
        }
        try {
            const result = await operation();
            this.onSuccess(operationName);
            return result;
        }
        catch (error) {
            this.onFailure(operationName, error);
            throw error;
        }
    }
    onSuccess(operationName) {
        this.successCount++;
        if (this.state === 'HALF_OPEN') {
            if (this.successCount >= 2) { // Require multiple successes to close
                this.state = 'CLOSED';
                this.failureCount = 0;
                logger.log(`Circuit breaker for ${operationName} moving to CLOSED state`);
            }
        }
        else if (this.state === 'CLOSED') {
            this.failureCount = 0;
        }
    }
    onFailure(operationName, error) {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        if (this.state === 'CLOSED' && this.failureCount >= this.config.failureThreshold) {
            this.state = 'OPEN';
            logger.error(`Circuit breaker for ${operationName} moving to OPEN state after ${this.failureCount} failures`);
        }
        else if (this.state === 'HALF_OPEN') {
            this.state = 'OPEN';
            logger.error(`Circuit breaker for ${operationName} moving back to OPEN state from HALF_OPEN`);
        }
    }
    getState() {
        return this.state;
    }
    getStats() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount
        };
    }
}
/**
 * Rate Limiting Handler
 */
export class RateLimitHandler {
    constructor() {
        this.rateLimitedUntil = 0;
        this.requestCount = 0;
        this.windowStart = Date.now();
        this.windowSizeMs = 60000; // 1 minute window
        this.maxRequestsPerWindow = 100;
    }
    async handleRateLimit(error) {
        if (this.isRateLimited(error)) {
            const retryAfter = this.extractRetryAfter(error);
            const waitTime = retryAfter || this.calculateBackoffTime();
            this.rateLimitedUntil = Date.now() + waitTime;
            logger.log(`Rate limited. Waiting ${waitTime}ms before next request`);
            await this.sleep(waitTime);
        }
    }
    async checkRateLimit() {
        const now = Date.now();
        // Check if still in rate limit period
        if (now < this.rateLimitedUntil) {
            const waitTime = this.rateLimitedUntil - now;
            logger.log(`Still rate limited. Waiting ${waitTime}ms`);
            await this.sleep(waitTime);
        }
        // Reset window if needed
        if (now - this.windowStart > this.windowSizeMs) {
            this.windowStart = now;
            this.requestCount = 0;
        }
        // Check request count in current window
        if (this.requestCount >= this.maxRequestsPerWindow) {
            const waitTime = this.windowSizeMs - (now - this.windowStart);
            logger.log(`Request limit reached. Waiting ${waitTime}ms for window reset`);
            await this.sleep(waitTime);
            this.windowStart = Date.now();
            this.requestCount = 0;
        }
        this.requestCount++;
    }
    isRateLimited(error) {
        const status = error?.status || error?.response?.status;
        const message = error?.message?.toLowerCase() || '';
        return status === 429 ||
            message.includes('rate limit') ||
            message.includes('quota exceeded') ||
            message.includes('too many requests');
    }
    extractRetryAfter(error) {
        const retryAfter = error?.response?.headers?.['retry-after'] ||
            error?.headers?.['retry-after'];
        if (retryAfter) {
            const seconds = parseInt(retryAfter);
            return isNaN(seconds) ? null : seconds * 1000;
        }
        return null;
    }
    calculateBackoffTime() {
        // Exponential backoff based on how recently we were rate limited
        const timeSinceLastLimit = Date.now() - (this.rateLimitedUntil - 60000);
        const backoffMultiplier = Math.min(Math.pow(2, Math.floor(timeSinceLastLimit / 30000)), 16);
        return Math.min(1000 * backoffMultiplier, 60000); // Max 1 minute wait
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
/**
 * Timeout Manager
 */
export class TimeoutManager {
    static async withTimeout(operation, timeoutMs, operationName) {
        return Promise.race([
            operation(),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new ResilientError(`Operation ${operationName} timed out after ${timeoutMs}ms`, 'TIMEOUT_ERROR', true));
                }, timeoutMs);
            })
        ]);
    }
}
/**
 * Graceful Degradation Manager
 */
export class GracefulDegradationManager {
    constructor() {
        this.enabledFeatures = new Set();
        this.disabledFeatures = new Set();
        this.featureErrors = new Map();
        // Enable all features by default
        this.enabledFeatures.add('enhanced_search');
        this.enabledFeatures.add('fuzzy_matching');
        this.enabledFeatures.add('cross_references');
        this.enabledFeatures.add('threading_intelligence');
        this.enabledFeatures.add('conversation_analysis');
        this.enabledFeatures.add('proactive_reminders');
    }
    isFeatureEnabled(feature) {
        // Auto-enable new features when first encountered
        if (!this.enabledFeatures.has(feature) && !this.disabledFeatures.has(feature)) {
            this.enabledFeatures.add(feature);
        }
        return this.enabledFeatures.has(feature) && !this.disabledFeatures.has(feature);
    }
    async executeWithDegradation(primaryOperation, fallbackOperation, featureName, operationName) {
        if (!this.isFeatureEnabled(featureName)) {
            logger.log(`Feature ${featureName} is disabled, using fallback for ${operationName}`);
            return fallbackOperation();
        }
        try {
            const result = await primaryOperation();
            this.recordSuccess(featureName);
            return result;
        }
        catch (error) {
            this.recordFailure(featureName, error);
            logger.error(`Primary operation failed for ${operationName}, falling back to basic implementation:`, error);
            return fallbackOperation();
        }
    }
    recordSuccess(feature) {
        if (this.featureErrors.has(feature)) {
            const errorCount = this.featureErrors.get(feature) - 1;
            if (errorCount <= 0) {
                this.featureErrors.delete(feature);
                if (this.disabledFeatures.has(feature)) {
                    this.disabledFeatures.delete(feature);
                    this.enabledFeatures.add(feature);
                    logger.log(`Re-enabled feature ${feature} after successful operation`);
                }
            }
            else {
                this.featureErrors.set(feature, errorCount);
            }
        }
    }
    recordFailure(feature, error) {
        const currentErrors = this.featureErrors.get(feature) || 0;
        const newErrorCount = currentErrors + 1;
        this.featureErrors.set(feature, newErrorCount);
        // Disable feature after 3 consecutive failures
        if (newErrorCount >= 3 && this.enabledFeatures.has(feature)) {
            this.enabledFeatures.delete(feature);
            this.disabledFeatures.add(feature);
            logger.error(`Disabled feature ${feature} after ${newErrorCount} failures`);
        }
    }
    getFeatureStatus() {
        const status = {};
        for (const feature of this.enabledFeatures) {
            status[feature] = this.featureErrors.has(feature) ? 'error' : 'enabled';
        }
        for (const feature of this.disabledFeatures) {
            status[feature] = 'disabled';
        }
        return status;
    }
}
/**
 * Resource Manager for proper cleanup
 */
export class ResourceManager {
    constructor() {
        this.resources = new Set();
        this.cleanupTimeout = null;
    }
    addResource(resource) {
        this.resources.add(resource);
    }
    removeResource(resource) {
        this.resources.delete(resource);
    }
    async cleanup() {
        const cleanupPromises = Array.from(this.resources).map(async (resource) => {
            try {
                await resource.cleanup();
            }
            catch (error) {
                logger.error('Error during resource cleanup:', error);
            }
        });
        await Promise.allSettled(cleanupPromises);
        this.resources.clear();
    }
    schedulePeriodicCleanup(intervalMs = 300000) {
        if (this.cleanupTimeout) {
            clearInterval(this.cleanupTimeout);
        }
        this.cleanupTimeout = setInterval(async () => {
            logger.log('Performing periodic resource cleanup');
            await this.cleanup();
        }, intervalMs);
    }
    stopPeriodicCleanup() {
        if (this.cleanupTimeout) {
            clearInterval(this.cleanupTimeout);
            this.cleanupTimeout = null;
        }
    }
}
/**
 * Main Resilience Manager
 * Combines all resilience features
 */
export class ResilienceManager {
    constructor(config = {}) {
        this.circuitBreakers = new Map();
        this.config = {
            retry: {
                maxAttempts: 3,
                baseDelayMs: 1000,
                maxDelayMs: 30000,
                backoffMultiplier: 2,
                jitterPercent: 10
            },
            circuitBreaker: {
                failureThreshold: 5,
                recoveryTimeoutMs: 60000,
                monitoringWindowMs: 300000
            },
            timeout: {
                operationTimeoutMs: 30000,
                connectionTimeoutMs: 10000
            },
            enableGracefulDegradation: true,
            ...config
        };
        this.retryManager = new RetryManager(this.config.retry);
        this.rateLimitHandler = new RateLimitHandler();
        this.degradationManager = new GracefulDegradationManager();
        this.resourceManager = new ResourceManager();
        // Start periodic cleanup
        this.resourceManager.schedulePeriodicCleanup();
    }
    async executeResilientOperation(operation, operationName, options = {}) {
        const { useCircuitBreaker = false, feature, fallback, timeout = this.config.timeout.operationTimeoutMs, customRetryConfig } = options;
        // Check rate limiting
        await this.rateLimitHandler.checkRateLimit();
        // Wrap operation with timeout
        const timeoutOperation = () => TimeoutManager.withTimeout(operation, timeout, operationName);
        // Apply circuit breaker if requested
        const circuitBreakerOperation = useCircuitBreaker
            ? () => this.getCircuitBreaker(operationName).execute(timeoutOperation, operationName)
            : timeoutOperation;
        // Apply retry logic
        const retryOperation = () => this.retryManager.executeWithRetry(circuitBreakerOperation, operationName, customRetryConfig);
        // Apply graceful degradation if feature and fallback provided
        if (this.config.enableGracefulDegradation && feature && fallback) {
            return this.degradationManager.executeWithDegradation(retryOperation, fallback, feature, operationName);
        }
        return retryOperation();
    }
    getCircuitBreaker(operationName) {
        if (!this.circuitBreakers.has(operationName)) {
            this.circuitBreakers.set(operationName, new CircuitBreaker(this.config.circuitBreaker));
        }
        return this.circuitBreakers.get(operationName);
    }
    getSystemStatus() {
        const circuitBreakerStats = {};
        for (const [name, cb] of this.circuitBreakers) {
            circuitBreakerStats[name] = cb.getStats();
        }
        return {
            features: this.degradationManager.getFeatureStatus(),
            circuitBreakers: circuitBreakerStats,
            rateLimiting: { active: Date.now() < this.rateLimitHandler['rateLimitedUntil'] }
        };
    }
    async shutdown() {
        logger.log('Shutting down resilience manager...');
        this.resourceManager.stopPeriodicCleanup();
        await this.resourceManager.cleanup();
    }
}
