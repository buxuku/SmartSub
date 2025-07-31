/**
 * Migration Manager
 *
 * Handles configuration migrations, version upgrades, and data transformations
 * for the parameter system.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { CustomParameterConfig } from '../../types/provider';
import type {
  StoredConfiguration,
  ConfigurationMetadata,
} from './configurationManager';

export interface MigrationInfo {
  id: string;
  version: string;
  description: string;
  date: string;
}

export interface MigrationResult {
  success: boolean;
  migrationsApplied: number;
  errors: string[];
  backupPath?: string;
}

export interface Migration {
  id: string;
  fromVersion: string;
  toVersion: string;
  description: string;
  migrate: (config: CustomParameterConfig) => Promise<CustomParameterConfig>;
  rollback?: (config: CustomParameterConfig) => Promise<CustomParameterConfig>;
}

export class MigrationManager {
  private readonly migrationDir: string;
  private readonly migrationLogFile: string;
  private readonly migrations: Migration[] = [];
  private appliedMigrations: MigrationInfo[] = [];

  constructor() {
    this.migrationDir = path.join(
      app.getPath('userData'),
      'parameter-configs',
      'migrations',
    );
    this.migrationLogFile = path.join(this.migrationDir, 'migration-log.json');

    this.registerMigrations();
  }

  /**
   * Initialize the migration manager
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.migrationDir, { recursive: true });
    await this.loadMigrationLog();
  }

  /**
   * Check if configurations need migration
   */
  async needsMigration(
    configurations: Map<string, StoredConfiguration>,
  ): Promise<boolean> {
    for (const [_, stored] of configurations) {
      if (this.getConfigurationVersion(stored) !== this.getCurrentVersion()) {
        return true;
      }
    }
    return false;
  }

  /**
   * Migrate all configurations to the current version
   */
  async migrateConfigurations(
    configurations: Map<string, StoredConfiguration>,
  ): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: true,
      migrationsApplied: 0,
      errors: [],
    };

    try {
      // Create backup before migration
      result.backupPath = await this.createMigrationBackup(configurations);

      for (const [providerId, stored] of configurations) {
        try {
          const migrated = await this.migrateConfiguration(stored);
          if (migrated !== stored) {
            configurations.set(providerId, migrated);
            result.migrationsApplied++;
          }
        } catch (error) {
          result.errors.push(
            `Failed to migrate configuration for ${providerId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
          result.success = false;
        }
      }

      // Log successful migrations
      if (result.migrationsApplied > 0) {
        await this.logMigration({
          id: `migration-${Date.now()}`,
          version: this.getCurrentVersion(),
          description: `Migrated ${result.migrationsApplied} configurations`,
          date: new Date().toISOString(),
        });
      }
    } catch (error) {
      result.errors.push(
        `Migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      result.success = false;
    }

    return result;
  }

  /**
   * Migrate a single configuration
   */
  async migrateConfiguration(
    stored: StoredConfiguration,
  ): Promise<StoredConfiguration> {
    const currentVersion = this.getConfigurationVersion(stored);
    const targetVersion = this.getCurrentVersion();

    if (currentVersion === targetVersion) {
      return stored; // No migration needed
    }

    let config = { ...stored.config };
    let metadata = { ...stored.metadata };

    // Apply migrations in sequence
    for (const migration of this.getMigrationsForVersionRange(
      currentVersion,
      targetVersion,
    )) {
      try {
        config = await migration.migrate(config);
        metadata.version = migration.toVersion;
        metadata.lastModified = new Date().toISOString();

        console.log(`Applied migration ${migration.id} to configuration`);
      } catch (error) {
        throw new Error(
          `Migration ${migration.id} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    return { config, metadata };
  }

  /**
   * Validate configuration health and integrity
   */
  async validateConfigurationHealth(
    configurations: Map<string, StoredConfiguration>,
  ): Promise<{
    isHealthy: boolean;
    issues: Array<{
      providerId: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      issue: string;
      recommendation: string;
    }>;
    summary: {
      totalConfigurations: number;
      healthyConfigurations: number;
      configurationsWithIssues: number;
      criticalIssues: number;
    };
  }> {
    const issues: Array<{
      providerId: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      issue: string;
      recommendation: string;
    }> = [];

    let healthyConfigurations = 0;

    for (const [providerId, stored] of configurations.entries()) {
      const configIssues = await this.validateSingleConfiguration(
        providerId,
        stored,
      );

      if (configIssues.length === 0) {
        healthyConfigurations++;
      } else {
        issues.push(...configIssues);
      }
    }

    const criticalIssues = issues.filter(
      (issue) => issue.severity === 'critical',
    ).length;
    const configurationsWithIssues =
      configurations.size - healthyConfigurations;

    return {
      isHealthy: criticalIssues === 0 && configurationsWithIssues === 0,
      issues,
      summary: {
        totalConfigurations: configurations.size,
        healthyConfigurations,
        configurationsWithIssues,
        criticalIssues,
      },
    };
  }

  /**
   * Validate a single configuration for health issues
   */
  private async validateSingleConfiguration(
    providerId: string,
    stored: StoredConfiguration,
  ): Promise<
    Array<{
      providerId: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      issue: string;
      recommendation: string;
    }>
  > {
    const issues: Array<{
      providerId: string;
      severity: 'low' | 'medium' | 'high' | 'critical';
      issue: string;
      recommendation: string;
    }> = [];

    // Check version compatibility
    const currentVersion = this.getConfigurationVersion(stored);
    const targetVersion = this.getCurrentVersion();

    if (currentVersion !== targetVersion) {
      const severity = this.getVersionCompatibilitySeverity(
        currentVersion,
        targetVersion,
      );
      issues.push({
        providerId,
        severity,
        issue: `Configuration version ${currentVersion} is outdated (current: ${targetVersion})`,
        recommendation: 'Run migration to update to the latest version',
      });
    }

    // Check metadata integrity
    if (!stored.metadata.checksum) {
      issues.push({
        providerId,
        severity: 'medium',
        issue: 'Configuration missing integrity checksum',
        recommendation: 'Regenerate checksum by saving configuration',
      });
    }

    // Check for empty configurations
    const headerCount = Object.keys(
      stored.config.headerParameters || {},
    ).length;
    const bodyCount = Object.keys(stored.config.bodyParameters || {}).length;

    if (headerCount === 0 && bodyCount === 0) {
      issues.push({
        providerId,
        severity: 'low',
        issue: 'Configuration has no parameters',
        recommendation: 'Add parameters or delete unused configuration',
      });
    }

    // Check for oversized configurations
    const configSize = JSON.stringify(stored.config).length;
    if (configSize > 50000) {
      // 50KB threshold
      issues.push({
        providerId,
        severity: 'medium',
        issue: `Configuration size (${Math.round(configSize / 1024)}KB) is large`,
        recommendation: 'Review and optimize parameter values',
      });
    }

    // Check for potentially sensitive data in parameter names/values
    const allParams = {
      ...stored.config.headerParameters,
      ...stored.config.bodyParameters,
    };

    for (const [key, value] of Object.entries(allParams)) {
      if (this.containsSensitiveData(key, value)) {
        issues.push({
          providerId,
          severity: 'high',
          issue: `Parameter '${key}' may contain sensitive data`,
          recommendation:
            'Use environment variables or secure configuration for sensitive data',
        });
      }
    }

    // Check for duplicate parameter names (case-insensitive)
    const paramNames = Object.keys(allParams).map((name) => name.toLowerCase());
    const duplicates = paramNames.filter(
      (name, index) => paramNames.indexOf(name) !== index,
    );

    if (duplicates.length > 0) {
      issues.push({
        providerId,
        severity: 'medium',
        issue: `Duplicate parameter names found: ${duplicates.join(', ')}`,
        recommendation: 'Rename or remove duplicate parameters',
      });
    }

    return issues;
  }

  /**
   * Get version compatibility severity
   */
  private getVersionCompatibilitySeverity(
    currentVersion: string,
    targetVersion: string,
  ): 'low' | 'medium' | 'high' | 'critical' {
    const current = this.parseVersion(currentVersion);
    const target = this.parseVersion(targetVersion);

    // Major version difference = critical
    if (current.major < target.major) {
      return 'critical';
    }

    // Minor version difference = high
    if (current.minor < target.minor) {
      return 'high';
    }

    // Patch version difference = medium
    if (current.patch < target.patch) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Parse semantic version string
   */
  private parseVersion(version: string): {
    major: number;
    minor: number;
    patch: number;
  } {
    const parts = version.split('.').map(Number);
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
    };
  }

  /**
   * Check if parameter contains sensitive data
   */
  private containsSensitiveData(key: string, value: any): boolean {
    const sensitivePatterns = [
      /password/i,
      /secret/i,
      /token/i,
      /key/i,
      /auth/i,
      /credential/i,
      /private/i,
      /api[_-]?key/i,
      /access[_-]?token/i,
    ];

    const keyLower = key.toLowerCase();
    const hasKeyPattern = sensitivePatterns.some((pattern) =>
      pattern.test(keyLower),
    );

    if (typeof value === 'string') {
      // Check for credential-like patterns in values
      const credentialValuePatterns = [
        /^[A-Za-z0-9+/]{20,}={0,2}$/, // Base64-like
        /^[a-f0-9]{32,}$/i, // Hex tokens
        /^sk-[a-zA-Z0-9]{20,}$/, // OpenAI-style
        /^xoxb-[a-zA-Z0-9-]+$/, // Slack tokens
        /^ghp_[a-zA-Z0-9]{36}$/, // GitHub tokens
      ];

      const hasValuePattern = credentialValuePatterns.some((pattern) =>
        pattern.test(value),
      );
      return hasKeyPattern && (hasValuePattern || value.length > 20);
    }

    return hasKeyPattern;
  }

  /**
   * Auto-repair configuration issues
   */
  async autoRepairConfiguration(
    providerId: string,
    stored: StoredConfiguration,
  ): Promise<{
    success: boolean;
    repairedConfig?: StoredConfiguration;
    repairsApplied: string[];
    errors: string[];
  }> {
    const result = {
      success: false,
      repairedConfig: undefined as StoredConfiguration | undefined,
      repairsApplied: [] as string[],
      errors: [] as string[],
    };

    try {
      let config = { ...stored.config };
      let metadata = { ...stored.metadata };

      // Repair 1: Update version if outdated
      const currentVersion = this.getConfigurationVersion(stored);
      const targetVersion = this.getCurrentVersion();

      if (currentVersion !== targetVersion) {
        metadata.version = targetVersion;
        metadata.lastModified = new Date().toISOString();
        result.repairsApplied.push(
          `Updated version from ${currentVersion} to ${targetVersion}`,
        );
      }

      // Repair 2: Generate missing checksum
      if (!metadata.checksum) {
        metadata.checksum = await this.calculateChecksum(config);
        result.repairsApplied.push('Generated missing integrity checksum');
      }

      // Repair 3: Remove empty parameter objects to clean up structure
      if (
        config.headerParameters &&
        Object.keys(config.headerParameters).length === 0
      ) {
        delete config.headerParameters;
        result.repairsApplied.push('Cleaned up empty header parameters object');
      }

      if (
        config.bodyParameters &&
        Object.keys(config.bodyParameters).length === 0
      ) {
        delete config.bodyParameters;
        result.repairsApplied.push('Cleaned up empty body parameters object');
      }

      // Repair 4: Fix duplicate parameter names (case-insensitive)
      const allParams = {
        ...config.headerParameters,
        ...config.bodyParameters,
      };

      const seen = new Set<string>();
      const duplicates = new Set<string>();

      for (const key of Object.keys(allParams)) {
        const lowerKey = key.toLowerCase();
        if (seen.has(lowerKey)) {
          duplicates.add(key);
        } else {
          seen.add(lowerKey);
        }
      }

      if (duplicates.size > 0) {
        // Remove duplicates from body parameters (keep header parameters)
        for (const dupKey of duplicates) {
          if (config.bodyParameters && dupKey in config.bodyParameters) {
            delete config.bodyParameters[dupKey];
            result.repairsApplied.push(
              `Removed duplicate parameter: ${dupKey}`,
            );
          }
        }
      }

      result.repairedConfig = { config, metadata };
      result.success = true;
    } catch (error) {
      result.errors.push(
        `Auto-repair failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    return result;
  }

  /**
   * Calculate configuration checksum
   */
  private async calculateChecksum(
    config: CustomParameterConfig,
  ): Promise<string> {
    const crypto = await import('crypto');
    const configString = JSON.stringify(config, Object.keys(config).sort());
    return crypto.createHash('sha256').update(configString).digest('hex');
  }

  /**
   * Rollback configuration to a previous version
   */
  async rollbackConfiguration(
    stored: StoredConfiguration,
    targetVersion: string,
  ): Promise<StoredConfiguration> {
    const currentVersion = this.getConfigurationVersion(stored);

    if (currentVersion === targetVersion) {
      return stored; // No rollback needed
    }

    let config = { ...stored.config };
    let metadata = { ...stored.metadata };

    // Apply rollbacks in reverse order
    const migrations = this.getMigrationsForVersionRange(
      targetVersion,
      currentVersion,
    ).reverse();

    for (const migration of migrations) {
      if (migration.rollback) {
        try {
          config = await migration.rollback(config);
          metadata.version = migration.fromVersion;
          metadata.lastModified = new Date().toISOString();

          console.log(`Applied rollback ${migration.id} to configuration`);
        } catch (error) {
          throw new Error(
            `Rollback ${migration.id} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      } else {
        throw new Error(`Migration ${migration.id} does not support rollback`);
      }
    }

    return { config, metadata };
  }

  /**
   * Get available migrations
   */
  getAvailableMigrations(): Migration[] {
    return [...this.migrations];
  }

  /**
   * Get applied migrations
   */
  getAppliedMigrations(): MigrationInfo[] {
    return [...this.appliedMigrations];
  }

  /**
   * Register all available migrations
   */
  private registerMigrations(): void {
    // Migration from version 0.9.0 to 1.0.0
    this.migrations.push({
      id: 'v0.9.0-to-v1.0.0',
      fromVersion: '0.9.0',
      toVersion: '1.0.0',
      description: 'Migrate from legacy parameter format to new structure',
      migrate: async (config: any) => {
        // Handle legacy format migration
        if (config.headerConfigs || config.bodyConfigs) {
          return {
            headerParameters: config.headerConfigs || {},
            bodyParameters: config.bodyConfigs || {},
            configVersion: '1.0.0',
            lastModified: Date.now(),
          };
        }
        return config;
      },
      rollback: async (config: CustomParameterConfig) => {
        return {
          headerConfigs: config.headerParameters || {},
          bodyConfigs: config.bodyParameters || {},
          configVersion: '0.9.0',
          lastModified: Date.now(),
        } as any;
      },
    });

    // Migration from version 1.0.0 to 1.1.0
    this.migrations.push({
      id: 'v1.0.0-to-v1.1.0',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      description: 'Add enhanced metadata and validation support',
      migrate: async (config: CustomParameterConfig) => {
        return {
          ...config,
          configVersion: '1.1.0',
          lastModified: Date.now(),
          // Add any new fields for version 1.1.0
        };
      },
      rollback: async (config: CustomParameterConfig) => {
        const { configVersion, lastModified, ...rest } = config;
        return {
          ...rest,
          configVersion: '1.0.0',
          lastModified: Date.now(),
        };
      },
    });

    // Future migration placeholder
    this.migrations.push({
      id: 'v1.1.0-to-v1.2.0',
      fromVersion: '1.1.0',
      toVersion: '1.2.0',
      description: 'Add template system integration',
      migrate: async (config: CustomParameterConfig) => {
        return {
          ...config,
          configVersion: '1.2.0',
          lastModified: Date.now(),
          // Future enhancements
        };
      },
    });
  }

  /**
   * Get the current configuration version
   */
  private getCurrentVersion(): string {
    return '1.2.0'; // Update this when adding new migrations
  }

  /**
   * Get the version of a stored configuration
   */
  private getConfigurationVersion(stored: StoredConfiguration): string {
    return stored.metadata.version || stored.config.configVersion || '0.9.0';
  }

  /**
   * Get migrations needed for a version range
   */
  private getMigrationsForVersionRange(
    fromVersion: string,
    toVersion: string,
  ): Migration[] {
    const from = this.parseVersion(fromVersion);
    const to = this.parseVersion(toVersion);

    return this.migrations
      .filter((migration) => {
        const migrationFrom = this.parseVersion(migration.fromVersion);
        const migrationTo = this.parseVersion(migration.toVersion);

        return (
          this.compareVersions(migrationFrom, from) >= 0 &&
          this.compareVersions(migrationTo, to) <= 0
        );
      })
      .sort((a, b) => {
        return this.compareVersions(
          this.parseVersion(a.fromVersion),
          this.parseVersion(b.fromVersion),
        );
      });
  }

  /**
   * Parse version string to comparable format
   */
  private parseVersion(version: string): number[] {
    return version.split('.').map((num) => parseInt(num, 10));
  }

  /**
   * Compare version arrays
   */
  private compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const aVal = a[i] || 0;
      const bVal = b[i] || 0;

      if (aVal !== bVal) {
        return aVal - bVal;
      }
    }
    return 0;
  }

  /**
   * Create backup before migration
   */
  private async createMigrationBackup(
    configurations: Map<string, StoredConfiguration>,
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(
      this.migrationDir,
      `pre-migration-backup-${timestamp}.json`,
    );

    const backup = {
      timestamp,
      configurations: Object.fromEntries(configurations),
      version: this.getCurrentVersion(),
    };

    await fs.writeFile(backupFile, JSON.stringify(backup, null, 2), 'utf8');
    return backupFile;
  }

  /**
   * Load migration log from disk
   */
  private async loadMigrationLog(): Promise<void> {
    try {
      const data = await fs.readFile(this.migrationLogFile, 'utf8');
      this.appliedMigrations = JSON.parse(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Failed to load migration log:', error);
      }
      this.appliedMigrations = [];
    }
  }

  /**
   * Log a migration
   */
  private async logMigration(migration: MigrationInfo): Promise<void> {
    this.appliedMigrations.push(migration);
    await fs.writeFile(
      this.migrationLogFile,
      JSON.stringify(this.appliedMigrations, null, 2),
      'utf8',
    );
  }

  /**
   * Validate configuration structure after migration
   */
  async validateMigratedConfiguration(
    config: CustomParameterConfig,
  ): Promise<boolean> {
    try {
      // Basic structure validation
      if (!config || typeof config !== 'object') {
        return false;
      }

      // Check required fields for current version
      const version = config.configVersion || '0.9.0';

      switch (version) {
        case '1.0.0':
        case '1.1.0':
        case '1.2.0':
          return (
            typeof config.headerParameters === 'object' &&
            typeof config.bodyParameters === 'object' &&
            typeof config.configVersion === 'string'
          );
        default:
          return true; // Allow older formats during migration
      }
    } catch {
      return false;
    }
  }

  /**
   * Get migration status for a configuration
   */
  getMigrationStatus(stored: StoredConfiguration): {
    currentVersion: string;
    targetVersion: string;
    needsMigration: boolean;
    availableMigrations: string[];
  } {
    const currentVersion = this.getConfigurationVersion(stored);
    const targetVersion = this.getCurrentVersion();
    const needsMigration = currentVersion !== targetVersion;
    const availableMigrations = this.getMigrationsForVersionRange(
      currentVersion,
      targetVersion,
    ).map((m) => m.id);

    return {
      currentVersion,
      targetVersion,
      needsMigration,
      availableMigrations,
    };
  }
}

// Export singleton instance
export const migrationManager = new MigrationManager();
