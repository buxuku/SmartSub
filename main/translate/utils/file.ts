import fs from 'fs/promises';
import path from 'path';
import { logMessage } from '../../helpers/storeManager';

export async function createOrClearFile(filePath: string): Promise<void> {
  try {
    await fs.writeFile(filePath, '');
  } catch (error) {
    logMessage(`Failed to create/clear file: ${error.message}`, 'error');
    throw error;
  }
}

export async function appendToFile(
  filePath: string,
  content: string,
): Promise<void> {
  try {
    await fs.appendFile(filePath, content);
  } catch (error) {
    logMessage(`Failed to append to file: ${error.message}`, 'error');
    throw error;
  }
}

export async function readFileContent(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.split('\n');
  } catch (error) {
    logMessage(`Failed to read file: ${error.message}`, 'error');
    throw error;
  }
}
