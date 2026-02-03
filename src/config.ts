import { watch, existsSync, readFileSync, writeFileSync } from "fs";
import { EventEmitter } from "events";
import type { SignatureType } from "./trader";

// Mode-specific trading parameters (for normal mode)
export interface ModeConfig {
  entryThreshold: number;
  maxEntryPrice: number;
  stopLoss: number;
  maxSpread: number;
  timeWindowMs: number;
  profitTarget: number;
}

// Ladder mode step configuration
export interface LadderStepSideConfig {
  triggerPrice: number;          // Price that triggers this side (0.01-0.99)
  sizeType: "percent" | "fixed"; // Percentage of balance or fixed USDC
  sizeValue: number;             // Amount (50 = 50% or $50)
}

export interface LadderStep {
  id: string;                    // Unique identifier (e.g., "step1")
  stopLoss: number;              // Stop-loss price for this step (0.01-0.99)
  buy: LadderStepSideConfig;     // Buy-side config
  sell: LadderStepSideConfig;    // Sell-side config
  enabled: boolean;              // Toggle individual steps
}

// Ladder mode configuration
export interface LadderModeConfig {
  // Initial entry filters (reuse from normal mode)
  entryThreshold: number;        // Min price to consider entry
  maxEntryPrice: number;         // Max price for initial entry
  maxSpread: number;             // Max bid-ask spread
  timeWindowMs: number;          // Time before market close to enter

  // Ladder-specific
  steps: LadderStep[];           // The ladder steps array
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
    [key: string]: ModeConfig | LadderModeConfig;
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

// Validate a mode configuration
function validateModeConfig(modeName: string, mode: ModeConfig): ValidationError[] {
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

  return errors;
}

// Validate a ladder mode configuration
function validateLadderModeConfig(modeName: string, mode: LadderModeConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const prefix = `modes.${modeName}`;

  // Entry filter validations
  if (!validateRange(mode.entryThreshold, 0.01, 0.99)) {
    errors.push({ path: `${prefix}.entryThreshold`, message: "must be between 0.01 and 0.99" });
  }
  if (!validateRange(mode.maxEntryPrice, 0.01, 0.99)) {
    errors.push({ path: `${prefix}.maxEntryPrice`, message: "must be between 0.01 and 0.99" });
  }
  if (!validateRange(mode.maxSpread, 0, 0.5)) {
    errors.push({ path: `${prefix}.maxSpread`, message: "must be between 0 and 0.5" });
  }
  if (mode.timeWindowMs <= 0) {
    errors.push({ path: `${prefix}.timeWindowMs`, message: "must be positive" });
  }
  if (mode.entryThreshold > mode.maxEntryPrice) {
    errors.push({ path: `${prefix}.entryThreshold`, message: "must be <= maxEntryPrice" });
  }

  // Steps validation
  if (!Array.isArray(mode.steps) || mode.steps.length === 0) {
    errors.push({ path: `${prefix}.steps`, message: "must have at least one step" });
  } else {
    const firstEnabledIndex = mode.steps.findIndex(step => step.enabled);
    if (firstEnabledIndex === -1) {
      errors.push({ path: `${prefix}.steps`, message: "must have at least one enabled step" });
    }

    const stepIds = new Set<string>();
    for (let i = 0; i < mode.steps.length; i++) {
      const step = mode.steps[i];
      const stepPrefix = `${prefix}.steps[${i}]`;

      // ID validation
      if (!step.id || typeof step.id !== "string" || step.id.trim() === "") {
        errors.push({ path: `${stepPrefix}.id`, message: "must be a non-empty string" });
      } else if (stepIds.has(step.id)) {
        errors.push({ path: `${stepPrefix}.id`, message: `duplicate step ID "${step.id}"` });
      } else {
        stepIds.add(step.id);
      }

      // Stop-loss validation
      if (!validateRange(step.stopLoss, 0.01, 0.99)) {
        errors.push({ path: `${stepPrefix}.stopLoss`, message: "must be between 0.01 and 0.99" });
      } else if (step.buy && step.stopLoss >= step.buy.triggerPrice) {
        errors.push({ path: `${stepPrefix}.stopLoss`, message: "must be less than buy.triggerPrice" });
      }

      // Buy config validation
      if (!step.buy || typeof step.buy !== "object") {
        errors.push({ path: `${stepPrefix}.buy`, message: "buy config is required" });
      } else {
        if (!validateRange(step.buy.triggerPrice, 0.01, 0.99)) {
          errors.push({ path: `${stepPrefix}.buy.triggerPrice`, message: "must be between 0.01 and 0.99" });
        }
        if (step.buy.sizeType !== "percent" && step.buy.sizeType !== "fixed") {
          errors.push({ path: `${stepPrefix}.buy.sizeType`, message: 'must be "percent" or "fixed"' });
        }
        if (step.buy.sizeValue <= 0) {
          errors.push({ path: `${stepPrefix}.buy.sizeValue`, message: "must be positive" });
        }
        if (step.buy.sizeType === "percent" && step.buy.sizeValue > 100) {
          errors.push({ path: `${stepPrefix}.buy.sizeValue`, message: "percent value must be <= 100" });
        }
      }

      // Sell config validation
      if (!step.sell || typeof step.sell !== "object") {
        errors.push({ path: `${stepPrefix}.sell`, message: "sell config is required" });
      } else {
        if (!validateRange(step.sell.triggerPrice, 0.01, 0.99)) {
          errors.push({ path: `${stepPrefix}.sell.triggerPrice`, message: "must be between 0.01 and 0.99" });
        }
        if (step.sell.sizeType !== "percent" && step.sell.sizeType !== "fixed") {
          errors.push({ path: `${stepPrefix}.sell.sizeType`, message: 'must be "percent" or "fixed"' });
        }
        if (step.sell.sizeValue <= 0) {
          errors.push({ path: `${stepPrefix}.sell.sizeValue`, message: "must be positive" });
        }
        if (step.sell.sizeType === "percent" && step.sell.sizeValue > 100) {
          errors.push({ path: `${stepPrefix}.sell.sizeValue`, message: "percent value must be <= 100" });
        }
      }

      // Enabled validation (should be boolean)
      if (typeof step.enabled !== "boolean") {
        errors.push({ path: `${stepPrefix}.enabled`, message: "must be a boolean" });
      }
    }
  }

  return errors;
}

// Check if a mode config is a ladder mode
function isLadderModeConfig(mode: ModeConfig | LadderModeConfig): mode is LadderModeConfig {
  return "steps" in mode && Array.isArray((mode as LadderModeConfig).steps);
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

  // Validate all modes (support both normal and ladder modes)
  for (const [modeName, modeConfig] of Object.entries(config.modes)) {
    if (isLadderModeConfig(modeConfig)) {
      errors.push(...validateLadderModeConfig(modeName, modeConfig as LadderModeConfig));
    } else {
      errors.push(...validateModeConfig(modeName, modeConfig as ModeConfig));
    }
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

export type RiskMode = "normal" | "ladder" | string;

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
   * Get the active mode's configuration (for normal mode)
   * Note: For ladder mode, use getLadderMode() instead
   */
  getActiveMode(): ModeConfig {
    const mode = this.config.modes[this.config.activeMode];
    if (isLadderModeConfig(mode)) {
      const firstEnabledStep = mode.steps.find(step => step.enabled);
      const stepStopLoss = firstEnabledStep ? firstEnabledStep.stopLoss : 0.01;
      // Return entry filter values as ModeConfig for compatibility
      return {
        entryThreshold: mode.entryThreshold,
        maxEntryPrice: mode.maxEntryPrice,
        stopLoss: stepStopLoss,
        maxSpread: mode.maxSpread,
        timeWindowMs: mode.timeWindowMs,
        profitTarget: 0.99, // Ladder mode doesn't use profit target, use default
      };
    }
    return mode as ModeConfig;
  }

  /**
   * Get a specific mode's configuration
   */
  getMode(modeName: string): ModeConfig | LadderModeConfig | undefined {
    return this.config.modes[modeName];
  }

  /**
   * Check if the active mode is ladder mode
   */
  isLadderMode(): boolean {
    const mode = this.config.modes[this.config.activeMode];
    return isLadderModeConfig(mode);
  }

  /**
   * Get the ladder mode configuration (only valid when isLadderMode() is true)
   */
  getLadderMode(): LadderModeConfig | null {
    const mode = this.config.modes[this.config.activeMode];
    if (isLadderModeConfig(mode)) {
      return mode;
    }
    return null;
  }

  /**
   * Convert to legacy BotConfig interface for compatibility
   * For ladder mode, uses entry filters and first enabled step stopLoss
   */
  toBotConfig(): BotConfig {
    const rawMode = this.config.modes[this.config.activeMode];
    const isLadder = isLadderModeConfig(rawMode);
    const mode = this.getActiveMode(); // This already converts ladder to compatible format
    const firstEnabledStep = isLadder ? (rawMode as LadderModeConfig).steps.find(step => step.enabled) : null;
    const ladderStopLoss = firstEnabledStep ? firstEnabledStep.stopLoss : mode.stopLoss;

    return {
      entryThreshold: mode.entryThreshold,
      maxEntryPrice: mode.maxEntryPrice,
      stopLoss: isLadder ? ladderStopLoss : mode.stopLoss,
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
   * For ladder mode, returns null (ladder uses step-based exits)
   */
  getProfitTarget(): number {
    const mode = this.config.modes[this.config.activeMode];
    if (isLadderModeConfig(mode)) {
      // Ladder mode doesn't use a single profit target, return high value
      return 0.99;
    }
    return (mode as ModeConfig).profitTarget;
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
