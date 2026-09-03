/**
 * Performance Optimization Module
 * Implements caching, batch operations, connection pooling, and memory management
 */
import { logger } from './api.js';
/**
 * High-Performance Email Cache System
 * LRU cache with compression and persistence options
 */
export class EmailCacheManager {
    constructor(config = {}) {
        this.cache = new Map();
        this.accessOrder = new Set();
        this.currentSize = 0;
        this.hits = 0;
        this.misses = 0;
        this.config = {
            maxSize: 1000,
            ttlMs: 3600000, // 1 hour
            enablePersistence: false,
            compressionLevel: 1,
            ...config
        };
        // Schedule periodic cleanup
        setInterval(() => this.cleanup(), 300000); // 5 minutes
    }
    async get(key) {
        const entry = this.cache.get(key);
        if (!entry) {
            this.misses++;
            return null;
        }
        // Check TTL
        if (Date.now() - entry.timestamp > this.config.ttlMs) {
            this.delete(key);
            this.misses++;
            return null;
        }
        // Update access tracking
        entry.lastAccessed = Date.now();
        entry.accessCount++;
        this.updateAccessOrder(key);
        this.hits++;
        // Decompress if needed
        if (entry.compressed) {
            return this.decompress(entry.data);
        }
        return entry.data;
    }
    async set(key, data, options = {}) {
        const { compress = false, priority = 'normal' } = options;
        // Calculate size
        const size = this.calculateSize(data);
        // Check if we need to evict entries
        while (this.currentSize + size > this.config.maxSize && this.cache.size > 0) {
            await this.evictLRU();
        }
        // Compress if enabled
        let finalData = data;
        let isCompressed = false;
        if (compress && this.config.compressionLevel > 0) {
            try {
                finalData = await this.compress(data);
                isCompressed = true;
            }
            catch (error) {
                logger.error('Compression failed, storing uncompressed:', error);
            }
        }
        const entry = {
            data: finalData,
            timestamp: Date.now(),
            accessCount: 1,
            lastAccessed: Date.now(),
            size,
            compressed: isCompressed
        };
        this.cache.set(key, entry);
        this.updateAccessOrder(key);
        this.currentSize += size;
        // Handle priority
        if (priority === 'high') {
            // Move to front of access order
            this.accessOrder.delete(key);
            this.accessOrder.add(key);
        }
    }
    delete(key) {
        const entry = this.cache.get(key);
        if (entry) {
            this.currentSize -= entry.size;
            this.cache.delete(key);
            this.accessOrder.delete(key);
            return true;
        }
        return false;
    }
    clear() {
        this.cache.clear();
        this.accessOrder.clear();
        this.currentSize = 0;
        this.hits = 0;
        this.misses = 0;
    }
    getStats() {
        const total = this.hits + this.misses;
        return {
            hitRate: total > 0 ? this.hits / total : 0,
            size: this.cache.size,
            memoryUsage: this.currentSize
        };
    }
    // Generate cache keys for different email operations
    static emailKey(messageId) {
        return `email:${messageId}`;
    }
    static searchKey(criteria) {
        return `search:${JSON.stringify(criteria)}`;
    }
    static threadKey(threadId) {
        return `thread:${threadId}`;
    }
    static attachmentKey(messageId, attachmentId) {
        return `attachment:${messageId}:${attachmentId}`;
    }
    updateAccessOrder(key) {
        this.accessOrder.delete(key);
        this.accessOrder.add(key);
    }
    async evictLRU() {
        const lruKey = this.accessOrder.values().next().value;
        if (lruKey) {
            this.delete(lruKey);
        }
    }
    calculateSize(data) {
        return JSON.stringify(data).length;
    }
    async compress(data) {
        // Simple compression simulation - in real implementation, use zlib or similar
        return JSON.stringify(data);
    }
    async decompress(data) {
        // Simple decompression simulation
        return typeof data === 'string' ? JSON.parse(data) : data;
    }
    cleanup() {
        const now = Date.now();
        const keysToDelete = [];
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.config.ttlMs) {
                keysToDelete.push(key);
            }
        }
        keysToDelete.forEach(key => this.delete(key));
        logger.log(`Cache cleanup: removed ${keysToDelete.length} expired entries`);
    }
}
/**
 * Batch Operation Manager
 * Efficiently handles bulk email operations
 */
export class BatchOperationManager {
    constructor(config = {}) {
        this.pendingOperations = new Map();
        this.batchTimers = new Map();
        this.activeBatches = 0;
        this.metrics = {
            totalOperations: 0,
            batchedOperations: 0,
            successfulBatches: 0,
            failedBatches: 0
        };
        this.config = {
            maxBatchSize: 100,
            batchTimeoutMs: 5000,
            concurrentBatches: 3,
            retryAttempts: 2,
            ...config
        };
    }
    async addToBatch(operationType, operation, executor) {
        return new Promise((resolve, reject) => {
            // Add operation to pending batch
            if (!this.pendingOperations.has(operationType)) {
                this.pendingOperations.set(operationType, []);
            }
            const batch = this.pendingOperations.get(operationType);
            batch.push({ operation, resolve, reject });
            // Check if batch is full
            if (batch.length >= this.config.maxBatchSize) {
                this.executeBatch(operationType, executor);
            }
            else {
                // Set timer for batch execution
                this.setBatchTimer(operationType, executor);
            }
            this.metrics.totalOperations++;
        });
    }
    setBatchTimer(operationType, executor) {
        // Clear existing timer
        if (this.batchTimers.has(operationType)) {
            clearTimeout(this.batchTimers.get(operationType));
        }
        // Set new timer
        const timer = setTimeout(() => {
            this.executeBatch(operationType, executor);
        }, this.config.batchTimeoutMs);
        this.batchTimers.set(operationType, timer);
    }
    async executeBatch(operationType, executor) {
        const batch = this.pendingOperations.get(operationType);
        if (!batch || batch.length === 0)
            return;
        // Check concurrent batch limit
        if (this.activeBatches >= this.config.concurrentBatches) {
            // Delay execution
            setTimeout(() => this.executeBatch(operationType, executor), 1000);
            return;
        }
        // Clear timer and pending operations
        if (this.batchTimers.has(operationType)) {
            clearTimeout(this.batchTimers.get(operationType));
            this.batchTimers.delete(operationType);
        }
        this.pendingOperations.set(operationType, []);
        this.activeBatches++;
        this.metrics.batchedOperations += batch.length;
        try {
            logger.log(`Executing batch of ${batch.length} ${operationType} operations`);
            // Extract operations
            const operations = batch.map(item => item.operation);
            // Execute batch
            const results = await executor(operations);
            // Resolve individual promises
            batch.forEach((item, index) => {
                item.resolve(results[index]);
            });
            this.metrics.successfulBatches++;
            logger.log(`Batch execution successful for ${operationType}`);
        }
        catch (error) {
            logger.error(`Batch execution failed for ${operationType}:`, error);
            // Reject all promises in batch
            batch.forEach(item => {
                item.reject(error);
            });
            this.metrics.failedBatches++;
        }
        finally {
            this.activeBatches--;
        }
    }
    getBatchStats() {
        const totalBatches = this.metrics.successfulBatches + this.metrics.failedBatches;
        return {
            totalOperations: this.metrics.totalOperations,
            batchedOperations: this.metrics.batchedOperations,
            batchEfficiency: this.metrics.totalOperations > 0 ? this.metrics.batchedOperations / this.metrics.totalOperations : 0,
            successRate: totalBatches > 0 ? this.metrics.successfulBatches / totalBatches : 0
        };
    }
    async shutdown() {
        // Execute all pending batches
        for (const [operationType, timer] of this.batchTimers.entries()) {
            clearTimeout(timer);
            // Note: executor not available here, so we'll just clear
        }
        this.pendingOperations.clear();
        this.batchTimers.clear();
    }
}
/**
 * Connection Pool Manager
 * Manages Gmail API connection pooling and optimization
 */
export class ConnectionPoolManager {
    constructor(config = {}) {
        this.activeConnections = new Set();
        this.idleConnections = new Map();
        this.connectionPromises = new Map();
        this.metrics = {
            connectionsCreated: 0,
            connectionsReused: 0,
            connectionTimeouts: 0,
            avgConnectionTime: 0
        };
        this.config = {
            maxConnections: 10,
            idleTimeoutMs: 300000, // 5 minutes
            connectionTimeoutMs: 10000,
            keepAliveMs: 60000,
            ...config
        };
        // Schedule connection cleanup
        setInterval(() => this.cleanupIdleConnections(), 60000); // 1 minute
    }
    async getConnection(connectionId = 'default') {
        // Check for existing connection promise
        if (this.connectionPromises.has(connectionId)) {
            return this.connectionPromises.get(connectionId);
        }
        // Check for idle connection
        const idleConnection = this.idleConnections.get(connectionId);
        if (idleConnection) {
            this.idleConnections.delete(connectionId);
            this.activeConnections.add(connectionId);
            this.metrics.connectionsReused++;
            logger.log(`Reusing connection: ${connectionId}`);
            return idleConnection.connection;
        }
        // Check connection limit
        if (this.activeConnections.size >= this.config.maxConnections) {
            // Wait for connection to become available
            await this.waitForAvailableConnection();
        }
        // Create new connection
        const connectionPromise = this.createConnection(connectionId);
        this.connectionPromises.set(connectionId, connectionPromise);
        try {
            const connection = await connectionPromise;
            this.activeConnections.add(connectionId);
            this.metrics.connectionsCreated++;
            logger.log(`Created new connection: ${connectionId}`);
            return connection;
        }
        finally {
            this.connectionPromises.delete(connectionId);
        }
    }
    releaseConnection(connectionId = 'default', connection) {
        this.activeConnections.delete(connectionId);
        // Add to idle connections
        this.idleConnections.set(connectionId, {
            timestamp: Date.now(),
            connection
        });
        logger.log(`Released connection to idle pool: ${connectionId}`);
    }
    closeConnection(connectionId = 'default') {
        this.activeConnections.delete(connectionId);
        this.idleConnections.delete(connectionId);
        this.connectionPromises.delete(connectionId);
        logger.log(`Closed connection: ${connectionId}`);
    }
    async createConnection(connectionId) {
        const startTime = Date.now();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.metrics.connectionTimeouts++;
                reject(new Error(`Connection timeout for ${connectionId}`));
            }, this.config.connectionTimeoutMs);
            // Simulate connection creation (replace with actual Gmail client creation)
            setTimeout(() => {
                clearTimeout(timeout);
                const connectionTime = Date.now() - startTime;
                this.updateAvgConnectionTime(connectionTime);
                // Mock connection object
                const connection = {
                    id: connectionId,
                    created: Date.now(),
                    keepAlive: setInterval(() => {
                        logger.log(`Keep-alive ping for connection: ${connectionId}`);
                    }, this.config.keepAliveMs)
                };
                resolve(connection);
            }, 100); // Simulate 100ms connection time
        });
    }
    async waitForAvailableConnection() {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.activeConnections.size < this.config.maxConnections || this.idleConnections.size > 0) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);
        });
    }
    cleanupIdleConnections() {
        const now = Date.now();
        const expiredConnections = [];
        for (const [connectionId, { timestamp, connection }] of this.idleConnections.entries()) {
            if (now - timestamp > this.config.idleTimeoutMs) {
                expiredConnections.push(connectionId);
                // Clean up keep-alive if exists
                if (connection.keepAlive) {
                    clearInterval(connection.keepAlive);
                }
            }
        }
        expiredConnections.forEach(id => {
            this.idleConnections.delete(id);
            logger.log(`Cleaned up expired idle connection: ${id}`);
        });
    }
    updateAvgConnectionTime(connectionTime) {
        const currentAvg = this.metrics.avgConnectionTime;
        const count = this.metrics.connectionsCreated;
        this.metrics.avgConnectionTime = (currentAvg * (count - 1) + connectionTime) / count;
    }
    getConnectionStats() {
        const total = this.metrics.connectionsCreated + this.metrics.connectionsReused;
        return {
            activeConnections: this.activeConnections.size,
            idleConnections: this.idleConnections.size,
            connectionsCreated: this.metrics.connectionsCreated,
            connectionsReused: this.metrics.connectionsReused,
            reuseRate: total > 0 ? this.metrics.connectionsReused / total : 0,
            avgConnectionTime: this.metrics.avgConnectionTime
        };
    }
    async shutdown() {
        // Close all connections
        for (const connectionId of this.activeConnections) {
            this.closeConnection(connectionId);
        }
        for (const [connectionId] of this.idleConnections) {
            this.closeConnection(connectionId);
        }
    }
}
/**
 * Memory Management and Streaming
 * Handles large result sets efficiently
 */
export class MemoryManager {
    constructor() {
        this.memoryThreshold = 100 * 1024 * 1024; // 100MB
        this.streamingThreshold = 1000; // Stream results larger than 1000 items
        this.currentMemoryUsage = 0;
    }
    async processLargeResultSet(data, processor, chunkSize = 100) {
        logger.log(`Processing large result set of ${data.length} items`);
        for (let i = 0; i < data.length; i += chunkSize) {
            const chunk = data.slice(i, i + chunkSize);
            await processor(chunk);
            // Check memory usage
            if (this.shouldTriggerGC()) {
                this.triggerGarbageCollection();
            }
            // Yield control to event loop
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    createAsyncIterator(data, chunkSize = 100) {
        const chunks = Math.ceil(data.length / chunkSize);
        let currentChunk = 0;
        return {
            async next() {
                if (currentChunk >= chunks) {
                    return { done: true, value: undefined };
                }
                const start = currentChunk * chunkSize;
                const end = Math.min(start + chunkSize, data.length);
                const chunk = data.slice(start, end);
                currentChunk++;
                return { done: false, value: chunk };
            },
            [Symbol.asyncIterator]() {
                return this;
            }
        };
    }
    shouldTriggerGC() {
        const memUsage = process.memoryUsage();
        this.currentMemoryUsage = memUsage.heapUsed;
        return memUsage.heapUsed > this.memoryThreshold;
    }
    triggerGarbageCollection() {
        if (global.gc) {
            global.gc();
            logger.log('Triggered garbage collection');
        }
    }
    getMemoryStats() {
        const memUsage = process.memoryUsage();
        return {
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external
        };
    }
}
/**
 * Performance Optimization Manager
 * Orchestrates all performance features
 */
export class PerformanceOptimizationManager {
    constructor(cacheConfig, batchConfig, connectionConfig) {
        this.cache = new EmailCacheManager(cacheConfig);
        this.batchManager = new BatchOperationManager(batchConfig);
        this.connectionPool = new ConnectionPoolManager(connectionConfig);
        this.memoryManager = new MemoryManager();
        this.startTime = Date.now();
    }
    // Cached email operations
    async getCachedEmail(messageId, fetcher) {
        const cacheKey = EmailCacheManager.emailKey(messageId);
        let email = await this.cache.get(cacheKey);
        if (!email) {
            email = await fetcher();
            await this.cache.set(cacheKey, email, { compress: true, priority: 'normal' });
        }
        return email;
    }
    async getCachedSearchResults(criteria, searcher) {
        const cacheKey = EmailCacheManager.searchKey(criteria);
        let results = await this.cache.get(cacheKey);
        if (!results) {
            results = await searcher();
            await this.cache.set(cacheKey, results, { compress: true, priority: 'high' });
        }
        return results;
    }
    // Batch operations
    async batchEmailOperation(operationType, operation, executor) {
        return this.batchManager.addToBatch(operationType, operation, executor);
    }
    // Connection management
    async getOptimizedConnection(connectionId) {
        return this.connectionPool.getConnection(connectionId);
    }
    releaseOptimizedConnection(connectionId = 'default', connection) {
        this.connectionPool.releaseConnection(connectionId, connection);
    }
    // Memory management
    async processLargeEmailSet(emails, processor, chunkSize) {
        return this.memoryManager.processLargeResultSet(emails, processor, chunkSize);
    }
    createEmailIterator(emails, chunkSize) {
        return this.memoryManager.createAsyncIterator(emails, chunkSize);
    }
    // Performance metrics
    getPerformanceMetrics() {
        const cacheStats = this.cache.getStats();
        const batchStats = this.batchManager.getBatchStats();
        const connectionStats = this.connectionPool.getConnectionStats();
        const memoryStats = this.memoryManager.getMemoryStats();
        return {
            cacheHitRate: cacheStats.hitRate,
            avgResponseTime: 0, // Would be calculated from actual operation timings
            memoryUsage: memoryStats.heapUsed,
            activeConnections: connectionStats.activeConnections,
            batchSuccessRate: batchStats.successRate,
            apiCallsReduced: Math.round(cacheStats.hitRate * 100) // Simplified metric
        };
    }
    async shutdown() {
        await this.batchManager.shutdown();
        await this.connectionPool.shutdown();
        this.cache.clear();
    }
}
