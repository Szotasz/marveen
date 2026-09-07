/**
 * Label Manager for Gmail MCP Server
 * Provides comprehensive label management functionality
 */
/**
 * Creates a new Gmail label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The newly created label
 */
export async function createLabel(gmail, labelName, options = {}) {
    try {
        // Default visibility settings if not provided
        const messageListVisibility = options.messageListVisibility || 'show';
        const labelListVisibility = options.labelListVisibility || 'labelShow';
        const response = await gmail.users.labels.create({
            userId: 'me',
            requestBody: {
                name: labelName,
                messageListVisibility,
                labelListVisibility,
            },
        });
        return response.data;
    }
    catch (error) {
        // Handle duplicate labels more gracefully
        if (error.message && error.message.includes('already exists')) {
            throw new Error(`Label "${labelName}" already exists. Please use a different name.`);
        }
        throw new Error(`Failed to create label: ${error.message}`);
    }
}
/**
 * Updates an existing Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to update
 * @param updates - Properties to update
 * @returns The updated label
 */
export async function updateLabel(gmail, labelId, updates) {
    try {
        // Verify the label exists before updating
        await gmail.users.labels.get({
            userId: 'me',
            id: labelId,
        });
        const response = await gmail.users.labels.update({
            userId: 'me',
            id: labelId,
            requestBody: updates,
        });
        return response.data;
    }
    catch (error) {
        if (error.code === 404) {
            throw new Error(`Label with ID "${labelId}" not found.`);
        }
        throw new Error(`Failed to update label: ${error.message}`);
    }
}
/**
 * Deletes a Gmail label
 * @param gmail - Gmail API instance
 * @param labelId - ID of the label to delete
 * @returns Success message
 */
export async function deleteLabel(gmail, labelId) {
    try {
        // Ensure we're not trying to delete system labels
        const label = await gmail.users.labels.get({
            userId: 'me',
            id: labelId,
        });
        if (label.data.type === 'system') {
            throw new Error(`Cannot delete system label with ID "${labelId}".`);
        }
        await gmail.users.labels.delete({
            userId: 'me',
            id: labelId,
        });
        return { success: true, message: `Label "${label.data.name}" deleted successfully.` };
    }
    catch (error) {
        if (error.code === 404) {
            throw new Error(`Label with ID "${labelId}" not found.`);
        }
        throw new Error(`Failed to delete label: ${error.message}`);
    }
}
/**
 * Gets a detailed list of all Gmail labels
 * @param gmail - Gmail API instance
 * @returns Object containing system and user labels
 */
export async function listLabels(gmail) {
    try {
        const response = await gmail.users.labels.list({
            userId: 'me',
        });
        const labels = response.data.labels || [];
        // Group labels by type for better organization
        const systemLabels = labels.filter((label) => label.type === 'system');
        const userLabels = labels.filter((label) => label.type === 'user');
        return {
            all: labels,
            system: systemLabels,
            user: userLabels,
            count: {
                total: labels.length,
                system: systemLabels.length,
                user: userLabels.length
            }
        };
    }
    catch (error) {
        throw new Error(`Failed to list labels: ${error.message}`);
    }
}
/**
 * Finds a label by name
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to find
 * @returns The found label or null if not found
 */
export async function findLabelByName(gmail, labelName) {
    try {
        const labelsResponse = await listLabels(gmail);
        const allLabels = labelsResponse.all;
        // Case-insensitive match
        const foundLabel = allLabels.find((label) => label.name.toLowerCase() === labelName.toLowerCase());
        return foundLabel || null;
    }
    catch (error) {
        throw new Error(`Failed to find label: ${error.message}`);
    }
}
/**
 * Creates label if it doesn't exist or returns existing label
 * @param gmail - Gmail API instance
 * @param labelName - Name of the label to create
 * @param options - Optional settings for the label
 * @returns The new or existing label
 */
export async function getOrCreateLabel(gmail, labelName, options = {}) {
    try {
        // First try to find an existing label
        const existingLabel = await findLabelByName(gmail, labelName);
        if (existingLabel) {
            return existingLabel;
        }
        // If not found, create a new one
        return await createLabel(gmail, labelName, options);
    }
    catch (error) {
        throw new Error(`Failed to get or create label: ${error.message}`);
    }
}
