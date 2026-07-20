import crypto from 'crypto';
import fs from 'fs';
import { dialog } from 'electron';
import { store } from './store';
import { logMessage } from './logger';
import { sanitizeStoragePathPatch } from './storagePaths';

const MAGIC = 'VSM_CONFIG';
const FORMAT_VERSION = 1;
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

interface EncryptedPayload {
  magic: string;
  version: number;
  salt: string;
  iv: string;
  authTag: string;
  data: string;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha512',
  );
}

function encryptData(jsonString: string, password: string): EncryptedPayload {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(jsonString, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    magic: MAGIC,
    version: FORMAT_VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptData(payload: EncryptedPayload, password: string): string {
  const salt = Buffer.from(payload.salt, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const authTag = Buffer.from(payload.authTag, 'base64');
  const encrypted = Buffer.from(payload.data, 'base64');
  const key = deriveKey(password, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

function collectExportData(): Record<string, any> {
  const settings = store.get('settings');
  const {
    modelsPath: _modelsPath,
    customTempDir: _customTempDir,
    storageRoot: _storageRoot,
    ...portableSettings
  } = settings;

  return {
    translationProviders: store.get('translationProviders') || [],
    userConfig: store.get('userConfig') || {},
    settings: portableSettings,
    customParameters: store.get('customParameters') || {},
    glossaries: store.get('glossaries') || [],
  };
}

function validateImportData(data: any): boolean {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.translationProviders)) return false;
  if (!data.userConfig || typeof data.userConfig !== 'object') return false;
  if (!data.settings || typeof data.settings !== 'object') return false;
  return true;
}

export async function exportConfig(
  password: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const data = collectExportData();
    const jsonString = JSON.stringify(data);
    const encrypted = encryptData(jsonString, password);

    const result = await dialog.showSaveDialog({
      title: 'Export Configuration',
      defaultPath: `smartsub-config-${new Date().toISOString().slice(0, 10)}.vsm`,
      filters: [{ name: 'SmartSub Config', extensions: ['vsm'] }],
    });

    if (result.canceled || !result.filePath) {
      return { success: false, error: 'canceled' };
    }

    await fs.promises.writeFile(
      result.filePath,
      JSON.stringify(encrypted, null, 2),
      'utf-8',
    );

    logMessage(`Config exported to ${result.filePath}`, 'info');
    return { success: true };
  } catch (error) {
    logMessage(`Config export failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
}

export async function importConfig(
  password: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Import Configuration',
      filters: [{ name: 'SmartSub Config', extensions: ['vsm'] }],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'canceled' };
    }

    const fileContent = await fs.promises.readFile(
      result.filePaths[0],
      'utf-8',
    );
    let payload: EncryptedPayload;

    try {
      payload = JSON.parse(fileContent);
    } catch {
      return { success: false, error: 'invalidConfigFile' };
    }

    if (
      payload.magic !== MAGIC ||
      !payload.salt ||
      !payload.iv ||
      !payload.authTag ||
      !payload.data
    ) {
      return { success: false, error: 'invalidConfigFile' };
    }

    let jsonString: string;
    try {
      jsonString = decryptData(payload, password);
    } catch {
      return { success: false, error: 'invalidPassword' };
    }

    let data: any;
    try {
      data = JSON.parse(jsonString);
    } catch {
      return { success: false, error: 'invalidConfigFile' };
    }

    if (!validateImportData(data)) {
      return { success: false, error: 'invalidConfigFile' };
    }

    const currentSettings = store.get('settings');
    store.set('translationProviders', data.translationProviders);
    store.set('userConfig', data.userConfig);
    // 中文路径兜底（design D6-2）：导入的旧配置可能带含 CJK 的引擎路径键
    const { sanitized, rejectedKeys } = sanitizeStoragePathPatch(data.settings);
    if (rejectedKeys.length > 0) {
      logMessage(
        `Config import: dropped storage path keys containing CJK characters: ${rejectedKeys.join(', ')}`,
        'warning',
      );
    }
    store.set('settings', {
      ...currentSettings,
      ...sanitized,
      // 机器本地路径不随配置迁移：保留本机现值
      modelsPath: currentSettings.modelsPath,
      customTempDir: currentSettings.customTempDir,
      storageRoot: currentSettings.storageRoot,
    });
    if (data.customParameters) {
      store.set('customParameters', data.customParameters);
    }
    if (Array.isArray(data.glossaries)) {
      store.set('glossaries', data.glossaries);
    }

    logMessage(`Config imported from ${result.filePaths[0]}`, 'info');
    return { success: true };
  } catch (error) {
    logMessage(`Config import failed: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
}
