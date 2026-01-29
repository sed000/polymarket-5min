import { watch, existsSync, readFileSync, writeFileSync } from "fs";
import { EventEmitter } from "events";
import type { SignatureType } from "./trader";

// Mode-specific trading parameters
export interface ModeConfig {
  entryThreshold: number;
  maxEntryPrice: number;
  stopLoss: number;
  maxSpread: number;
  timeWindowMs: number;
  profitTarget: number;
}

// Dynamic-risk mode has additional parameters
export interface DynamicModeConfig extends ModeConfig {
  baseThreshold: number;
  thresholdIncrement: number;
  maxThreshold: number;
  maxDrawdownPercent: number;
}

// Full trading config file structure
export interface TradingConfigFile {
  trading: {
    paperTrading: boolean;
    paperBalance: number;
    maxPositions: number;
    pollIntervalMs: number;
  };
  wallet: {
    signatureType: SignatureType;
    funderAddress: string | null;
  };
  profitTaking: {
    compoundLimit: number;
    baseBalance: number;
  };
  activeMode: string;
  modes: {
    [key: string]: ModeConfig | DynamicModeConfig;
  };
  backtest: {
    mode: string;
    startingBalance: number;
    days: number;
    slippage: number;
  };
  advanced: {
    wsPriceMaxAgeMs: number;
    marketRefreshInterval: number;
    paperFeeRate: number;
  };
}

// Default configuration
const DEFAULT_CONFIG: TradingConfigFile = {
  trading: {
    paperTrading: true,
    paperBalance: 100,
    maxPositions: 1,
    pollIntervalMs: 10000,
  },
  wallet: {
    signatureType: 0,
    funderAddress: null,
  },
  profitTaking: {
    compoundLimit: 0,
    baseBalance: 10,
  },
  activeMode: "normal",
  modes: {
    normal: {
      entryThreshold: 0.95,
      maxEntryPrice: 0.98,
      stopLoss: 0.80,
      maxSpread: 0.03,
      timeWindowMs: 300000,
      profitTarget: 0.99,
    },
    safe: {
      entryThreshold: 0.95,
      maxEntryPrice: 0.97,
      stopLoss: 0.90,
      maxSpread: 0.03,
      timeWindowMs: 300000,
      profitTarget: 0.98,
    },
    "super-risk": {
      entryThreshold: 0.70,
      maxEntryPrice: 0.95,
      stopLoss: 0.40,
      maxSpread: 0.05,
      timeWindowMs: 900000,
      profitTarget: 0.98,
    },
    "dynamic-risk": {
      entryThreshold: 0.70, // Base threshold (for display/initial)
      baseThreshold: 0.70,
      thresholdIncrement: 0.05,
      maxThreshold: 0.85,
      maxEntryPrice: 0.95,
      stopLoss: 0.40, // Fallback only
      maxDrawdownPercent: 0.325,
      maxSpread: 0.05,
      timeWindowMs: 900000,
      profitTarget: 0.98,
    },
  },
  backtest: {
    mode: "normal",
    startingBalance: 100,
    days: 7,
    slippage: 0.001,
  },
  advanced: {
    wsPriceMaxAgeMs: 5000,
    marketRefreshInterval: 30000,
    paperFeeRate: 0.01,
  },
};

// Validation helpers
const validateRange = (val: number, min: number, max: number): boolean =>
  !isNaN(val) && val >= min && val <= max;

export interface ValidationError {
  path: string;
  message: string;
}

// Check if a mode config is dynamic-risk type
export function isDynamicMode(mode: ModeConfig | DynamicModeConfig): mode is DynamicModeConfig {
  return "baseThreshold" in mode && "maxDrawdownPercent" in mode;
}

// Validate a mode configuration
function validateModeConfig(modeName: string, mode: ModeConfig | DynamicModeConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `modes.${modeName}`;

  if (!validateRange(mode.entryThreshold, 0.01, 0.99)) {
    errors.push({ path: `${prefix}.entryThreshold`, message: "must be between 0.01 and 0.99" });
  }
  if (!validateRange(mode.maxEntryPrice, 0.01, 0.99)) {
    errors.push({ path: `${prefix}.maxEntryPrice`, message: "must be between 0.01 and 0.99" });
  }
  if (!validateRange(mode.stopLoss, 0.01, 0.99)) {
    errors.push({ path: `${prefix}.stopLoss`, message: "must be between 0.01 and 0.99" });
  }
  if (!validateRange(mode.profitTarget, 0.01, 0.99)) {
    errors.push({ path: `${prefix}.profitTarget`, message: "must be between 0.01 and 0.99" });
  }
  if (!validateRange(mode.maxSpread, 0, 0.5)) {
    errors.push({ path: `${prefix}.maxSpread`, message: "must be between 0 and 0.5" });
  }
  if (mode.timeWindowMs <= 0) {
    errors.push({ path: `${prefix}.timeWindowMs`, message: "must be positive" });
  }

  // Logical validations
  if (mode.stopLoss >= mode.entryThreshold) {
    errors.push({ path: `${prefix}.stopLoss`, message: "must be less than entryThreshold" });
  }
  if (mode.entryThreshold > mode.maxEntryPrice) {
    errors.push({ path: `${prefix}.entryThreshold`, message: "must be <= maxEntryPrice" });
  }
  if (mode.maxEntryPrice >= mode.profitTarget) {
    errors.push({ path: `${prefix}.maxEntryPrice`, message: "must be less than profitTarget" });
  }

  // Dynamic-risk specific validations
  if (isDynamicMode(mode)) {
    if (!validateRange(mode.baseThreshold, 0.01, 0.99)) {
      errors.push({ path: `${prefix}.baseThreshold`, message: "must be between 0.01 and 0.99" });
    }
    if (!validateRange(mode.thresholdIncrement, 0.01, 0.2)) {
      errors.push({ path: `${prefix}.thresholdIncrement`, message: "must be between 0.01 and 0.2" });
    }
    if (!validateRange(mode.maxThreshold, 0.01, 0.99)) {
      errors.push({ path: `${prefix}.maxThreshold`, message: "must be between 0.01 and 0.99" });
    }
    if (!validateRange(mode.maxDrawdownPercent, 0.01, 0.99)) {
      errors.push({ path: `${prefix}.maxDrawdownPercent`, message: "must be between 0.01 and 0.99" });
    }
    if (mode.baseThreshold >= mode.maxThreshold) {
      errors.push({ path: `${prefix}.baseThreshold`, message: "must be less than maxThreshold" });
    }
  }

  return errors;
}

// Validate full configuration
function validateConfig(config: TradingConfigFile): ValidationError[] {
  const errors: ValidationError[] = [];

  // Trading section
  if (config.trading.paperBalance <= 0) {
    errors.push({ path: "trading.paperBalance", message: "must be positive" });
  }
  if (config.trading.maxPositions < 1) {
    errors.push({ path: "trading.maxPositions", message: "must be at least 1" });
  }
  if (config.trading.pollIntervalMs < 1000) {
    errors.push({ path: "trading.pollIntervalMs", message: "must be at least 1000ms" });
  }

  // Wallet section
  const validSigTypes: SignatureType[] = [0, 1, 2];
  if (!validSigTypes.includes(config.wallet.signatureType)) {
    errors.push({ path: "wallet.signatureType", message: "must be 0, 1, or 2" });
  }
  if (config.wallet.signatureType === 1 && !config.wallet.funderAddress && !config.trading.paperTrading) {
    errors.push({ path: "wallet.funderAddress", message: "required when signatureType is 1 (Magic.link proxy)" });
  }

  // Profit taking section
  if (config.profitTaking.compoundLimit < 0) {
    errors.push({ path: "profitTaking.compoundLimit", message: "must be >= 0 (0 disables)" });
  }
  if (config.profitTaking.baseBalance <= 0) {
    errors.push({ path: "profitTaking.baseBalance", message: "must be positive" });
  }

  // Active mode must exist
  if (!config.modes[config.activeMode]) {
    errors.push({ path: "activeMode", message: `mode "${config.activeMode}" not found in modes` });
  }

  // Validate all modes
  for (const [modeName, modeConfig] of Object.entries(config.modes)) {
    errors.push(...validateModeConfig(modeName, modeConfig));
  }

  // Backtest section
  if (!config.modes[config.backtest.mode]) {
    errors.push({ path: "backtest.mode", message: `mode "${config.backtest.mode}" not found in modes` });
  }
  if (config.backtest.startingBalance <= 0) {
    errors.push({ path: "backtest.startingBalance", message: "must be positive" });
  }
  if (config.backtest.days <= 0) {
    errors.push({ path: "backtest.days", message: "must be positive" });
  }
  if (!validateRange(config.backtest.slippage, 0, 0.1)) {
    errors.push({ path: "backtest.slippage", message: "must be between 0 and 0.1" });
  }

  // Advanced section
  if (config.advanced.wsPriceMaxAgeMs < 1000) {
    errors.push({ path: "advanced.wsPriceMaxAgeMs", message: "must be at least 1000ms" });
  }
  if (config.advanced.marketRefreshInterval < 5000) {
    errors.push({ path: "advanced.marketRefreshInterval", message: "must be at least 5000ms" });
  }
  if (!validateRange(config.advanced.paperFeeRate, 0, 0.1)) {
    errors.push({ path: "advanced.paperFeeRate", message: "must be between 0 and 0.1" });
  }

  return errors;
}

// Deep merge utility
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as (keyof T)[]) {
    const sourceVal = source[key];
    if (sourceVal !== undefined) {
      if (
        typeof sourceVal === "object" &&
        sourceVal !== null &&
        !Array.isArray(sourceVal) &&
        typeof result[key] === "object" &&
        result[key] !== null
      ) {
        result[key] = deepMerge(result[key] as object, sourceVal as object) as T[keyof T];
      } else {
        result[key] = sourceVal as T[keyof T];
      }
    }
  }
  return result;
}

export type ConfigChangeEvent = {
  previous: TradingConfigFile;
  current: TradingConfigFile;
  changedPaths: string[];
};

export type RiskMode = "normal" | "super-risk" | "dynamic-risk" | "safe" | string;

// Legacy BotConfig interface for compatibility
export interface BotConfig {
  entryThreshold: number;
  maxEntryPrice: number;
  stopLoss: number;
  maxSpread: number;
  timeWindowMs: number;
  pollIntervalMs: number;
  paperTrading: boolean;
  paperBalance: number;
  riskMode: RiskMode;
  compoundLimit: number;
  baseBalance: number;
  signatureType: SignatureType;
  funderAddress?: string;
  maxPositions: number;
}

export class ConfigManager extends EventEmitter {
  private config: TradingConfigFile;
  private configPath: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimer: Timer | null = null;

  constructor(configPath: string = "trading.config.json") {
    super();
    this.configPath = configPath;
    this.config = this.loadConfig();
  }

  private loadConfig(): TradingConfigFile {
    if (!existsSync(this.configPath)) {
      // Create default config file
      console.log(`Creating default config file: ${this.configPath}`);
      writeFileSync(this.configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return structuredClone(DEFAULT_CONFIG);
    }

    try {
      const content = readFileSync(this.configPath, "utf-8");
      const parsed = JSON.parse(content) as Partial<TradingConfigFile>;

      // Merge with defaults to ensure all fields exist
      const merged = deepMerge(structuredClone(DEFAULT_CONFIG), parsed);

      // Validate
      const errors = validateConfig(merged);
      if (errors.length > 0) {
        console.error("Configuration errors:");
        for (const err of errors) {
          console.error(`  - ${err.path}: ${err.message}`);
        }
        throw new Error("Invalid configuration");
      }

      return merged;
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error(`Invalid JSON in ${this.configPath}: ${err.message}`);
        throw err;
      }
      throw err;
    }
  }

  /**
   * Start watching the config file for changes
   */
  startWatching(): void {
    if (this.watcher) return;

    this.watcher = watch(this.configPath, (eventType) => {
      if (eventType === "change") {
        // Debounce to avoid rapid reloads
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(() => {
          this.reloadConfig();
        }, 100);
      }
    });
  }

  /**
   * Stop watching the config file
   */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Reload configuration from file
   * Returns true if config changed, false otherwise
   */
  private reloadConfig(): boolean {
    try {
      const previous = this.config;
      const newConfig = this.loadConfig();

      // Find changed paths
      const changedPaths = this.findChangedPaths(previous, newConfig);

      if (changedPaths.length === 0) {
        return false;
      }

      this.config = newConfig;

      const event: ConfigChangeEvent = {
        previous,
        current: newConfig,
        changedPaths,
      };

      this.emit("change", event);
      console.log(`[CONFIG] Reloaded: ${changedPaths.join(", ")}`);

      return true;
    } catch (err) {
      console.error(`[CONFIG] Failed to reload: ${err instanceof Error ? err.message : err}`);
      this.emit("error", err);
      return false;
    }
  }

  /**
   * Find paths that changed between two configs
   */
  private findChangedPaths(
    prev: TradingConfigFile,
    next: TradingConfigFile,
    prefix = ""
  ): string[] {
    const changes: string[] = [];

    const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const prevVal = (prev as any)[key];
      const nextVal = (next as any)[key];

      if (typeof prevVal === "object" && typeof nextVal === "object" && prevVal !== null && nextVal !== null) {
        changes.push(...this.findChangedPaths(prevVal, nextVal, path));
      } else if (prevVal !== nextVal) {
        changes.push(path);
      }
    }

    return changes;
  }

  /**
   * Get the full configuration
   */
  getConfig(): TradingConfigFile {
    return this.config;
  }

  /**
   * Get the active mode name
   */
  getActiveModeName(): string {
    return this.config.activeMode;
  }

  /**
   * Get the active mode's configuration
   */
  getActiveMode(): ModeConfig | DynamicModeConfig {
    return this.config.modes[this.config.activeMode];
  }

  /**
   * Get a specific mode's configuration
   */
  getMode(modeName: string): ModeConfig | DynamicModeConfig | undefined {
    return this.config.modes[modeName];
  }

  /**
   * Check if the active mode is dynamic-risk
   */
  isDynamicRiskMode(): boolean {
    return isDynamicMode(this.getActiveMode());
  }

  /**
   * Get dynamic entry threshold based on consecutive losses
   */
  getDynamicEntryThreshold(consecutiveLosses: number): number {
    const mode = this.getActiveMode();
    if (!isDynamicMode(mode)) {
      return mode.entryThreshold;
    }

    const lossAdjustment = Math.min(
      consecutiveLosses * mode.thresholdIncrement,
      mode.maxThreshold - mode.baseThreshold
    );
    return mode.baseThreshold + lossAdjustment;
  }

  /**
   * Convert to legacy BotConfig interface for compatibility
   */
  toBotConfig(): BotConfig {
    const mode = this.getActiveMode();

    return {
      entryThreshold: mode.entryThreshold,
      maxEntryPrice: mode.maxEntryPrice,
      stopLoss: mode.stopLoss,
      maxSpread: mode.maxSpread,
      timeWindowMs: mode.timeWindowMs,
      pollIntervalMs: this.config.trading.pollIntervalMs,
      paperTrading: this.config.trading.paperTrading,
      paperBalance: this.config.trading.paperBalance,
      riskMode: this.config.activeMode as RiskMode,
      compoundLimit: this.config.profitTaking.compoundLimit,
      baseBalance: this.config.profitTaking.baseBalance,
      signatureType: this.config.wallet.signatureType,
      funderAddress: this.config.wallet.funderAddress || undefined,
      maxPositions: this.config.trading.maxPositions,
    };
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Get profit target for current mode
   */
  getProfitTarget(): number {
    return this.getActiveMode().profitTarget;
  }

  /**
   * Get advanced configuration values
   */
  getAdvanced(): TradingConfigFile["advanced"] {
    return this.config.advanced;
  }

  /**
   * Get backtest configuration
   */
  getBacktestConfig(): TradingConfigFile["backtest"] {
    return this.config.backtest;
  }

  /**
   * Register a callback for config changes
   */
  onConfigChange(callback: (event: ConfigChangeEvent) => void): void {
    this.on("change", callback);
  }

  /**
   * Register a callback for config errors
   */
  onConfigError(callback: (error: Error) => void): void {
    this.on("error", callback);
  }
}

// Singleton instance for global access
let globalConfigManager: ConfigManager | null = null;

/**
 * Get or create the global ConfigManager instance
 */
export function getConfigManager(configPath?: string): ConfigManager {
  if (!globalConfigManager) {
    globalConfigManager = new ConfigManager(configPath);
  }
  return globalConfigManager;
}

/**
 * Reset the global ConfigManager (for testing)
 */
export function resetConfigManager(): void {
  if (globalConfigManager) {
    globalConfigManager.stopWatching();
    globalConfigManager = null;
  }
}
