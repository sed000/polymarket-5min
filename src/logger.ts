/**
 * Structured logging module for the trading bot
 * Provides consistent, parseable log output with levels and context
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  details?: Record<string, unknown>;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  outputJson?: boolean;
  onLog?: (entry: LogEntry) => void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: LogLevel;
  private outputJson: boolean;
  private onLog?: (entry: LogEntry) => void;
  private logs: LogEntry[] = [];
  private maxLogs = 100;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.minLevel || "info";
    this.outputJson = options.outputJson || false;
    this.onLog = options.onLog;
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.minLevel];
  }

  private createEntry(level: LogLevel, event: string, details?: Record<string, unknown>): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      event,
      details,
    };
  }

  private formatEntry(entry: LogEntry): string {
    if (this.outputJson) {
      return JSON.stringify(entry);
    }

    const levelTag = `[${entry.level.toUpperCase()}]`.padEnd(7);
    const time = entry.timestamp.slice(11, 19); // HH:MM:SS
    let message = `[${time}] ${levelTag} ${entry.event}`;

    if (entry.details && Object.keys(entry.details).length > 0) {
      const detailStr = Object.entries(entry.details)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(" ");
      message += ` | ${detailStr}`;
    }

    return message;
  }

  private log(level: LogLevel, event: string, details?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry = this.createEntry(level, event, details);

    // Store in memory
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Notify callback
    if (this.onLog) {
      this.onLog(entry);
    }

    // Console output
    const formatted = this.formatEntry(entry);
    switch (level) {
      case "error":
        console.error(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      default:
        console.log(formatted);
    }
  }

  debug(event: string, details?: Record<string, unknown>): void {
    this.log("debug", event, details);
  }

  info(event: string, details?: Record<string, unknown>): void {
    this.log("info", event, details);
  }

  warn(event: string, details?: Record<string, unknown>): void {
    this.log("warn", event, details);
  }

  error(event: string, details?: Record<string, unknown>): void {
    this.log("error", event, details);
  }

  /**
   * Log an error with stack trace extraction
   */
  logError(event: string, err: unknown, extraDetails?: Record<string, unknown>): void {
    const details: Record<string, unknown> = { ...extraDetails };

    if (err instanceof Error) {
      details.errorMessage = err.message;
      details.errorName = err.name;
      if (err.stack) {
        // Extract first line of stack for brevity
        const stackLines = err.stack.split("\n");
        details.errorStack = stackLines.slice(0, 3).join(" | ");
      }
    } else {
      details.errorMessage = String(err);
    }

    this.log("error", event, details);
  }

  /**
   * Get recent log entries
   */
  getRecentLogs(count?: number): LogEntry[] {
    const n = count || this.maxLogs;
    return this.logs.slice(-n);
  }

  /**
   * Get formatted log strings (for UI display)
   */
  getFormattedLogs(count?: number): string[] {
    return this.getRecentLogs(count).map(e => this.formatEntry(e));
  }

  /**
   * Clear log history
   */
  clearLogs(): void {
    this.logs = [];
  }

  /**
   * Set minimum log level
   */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }
}

// Default singleton instance
let defaultLogger: Logger | null = null;

export function getLogger(options?: LoggerOptions): Logger {
  if (!defaultLogger) {
    defaultLogger = new Logger(options);
  }
  return defaultLogger;
}

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}
