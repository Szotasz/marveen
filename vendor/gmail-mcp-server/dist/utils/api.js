import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Set up logging to temp file
const logFile = path.join(os.tmpdir(), 'gmail-mcp-server.log');
// Logger utility functions
export const logger = {
    log: (message) => {
        fs.appendFileSync(logFile, `[INFO] ${new Date().toISOString()} - ${message}\n`);
    },
    error: (message, error) => {
        fs.appendFileSync(logFile, `[ERROR] ${new Date().toISOString()} - ${message}\n`);
        if (error) {
            fs.appendFileSync(logFile, `${error.stack || error}\n`);
        }
    }
};
