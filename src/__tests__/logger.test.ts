import { describe, test, expect, beforeEach } from "bun:test";
import { Logger, createLogger, type LogEntry, type LogLevel } from "../logger";

describe("Logger", () => {
  let logger: Logger;
  let capturedLogs: LogEntry[];

  beforeEach(() => {
    capturedLogs = [];
    logger = createLogger({
      minLevel: "debug",
      onLog: (entry) => capturedLogs.push(entry),
    });
  });

  describe("log levels", () => {
    test("logs debug messages when minLevel is debug", () => {
      logger.debug("test message");
      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].level).toBe("debug");
      expect(capturedLogs[0].event).toBe("test message");
    });

    test("logs info messages", () => {
      logger.info("info message");
      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].level).toBe("info");
    });

    test("logs warn messages", () => {
      logger.warn("warning message");
      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].level).toBe("warn");
    });

    test("logs error messages", () => {
      logger.error("error message");
      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].level).toBe("error");
    });

    test("filters messages below minLevel", () => {
      const infoLogger = createLogger({
        minLevel: "info",
        onLog: (entry) => capturedLogs.push(entry),
      });

      infoLogger.debug("should not appear");
      infoLogger.info("should appear");

      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].event).toBe("should appear");
    });

    test("setLevel changes minimum level", () => {
      logger.setLevel("error");
      logger.info("should not appear");
      logger.error("should appear");

      expect(capturedLogs).toHaveLength(1);
      expect(capturedLogs[0].level).toBe("error");
    });
  });

  describe("log details", () => {
    test("includes details in log entry", () => {
      logger.info("trade executed", { side: "UP", price: 0.95, shares: 100 });

      expect(capturedLogs[0].details).toEqual({
        side: "UP",
        price: 0.95,
        shares: 100,
      });
    });

    test("handles empty details", () => {
      logger.info("simple message");
      expect(capturedLogs[0].details).toBeUndefined();
    });
  });

  describe("error logging", () => {
    test("extracts error message and name", () => {
      const error = new Error("Something went wrong");
      logger.logError("operation failed", error);

      expect(capturedLogs[0].level).toBe("error");
      expect(capturedLogs[0].details?.errorMessage).toBe("Something went wrong");
      expect(capturedLogs[0].details?.errorName).toBe("Error");
    });

    test("handles non-Error objects", () => {
      logger.logError("operation failed", "string error");

      expect(capturedLogs[0].details?.errorMessage).toBe("string error");
    });

    test("includes extra details with error", () => {
      const error = new Error("test");
      logger.logError("failed", error, { tokenId: "abc123" });

      expect(capturedLogs[0].details?.tokenId).toBe("abc123");
      expect(capturedLogs[0].details?.errorMessage).toBe("test");
    });
  });

  describe("log history", () => {
    test("stores recent logs", () => {
      logger.info("message 1");
      logger.info("message 2");
      logger.info("message 3");

      const recent = logger.getRecentLogs();
      expect(recent).toHaveLength(3);
    });

    test("respects count limit on getRecentLogs", () => {
      logger.info("message 1");
      logger.info("message 2");
      logger.info("message 3");

      const recent = logger.getRecentLogs(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].event).toBe("message 2");
      expect(recent[1].event).toBe("message 3");
    });

    test("clearLogs removes all logs", () => {
      logger.info("message 1");
      logger.info("message 2");
      logger.clearLogs();

      expect(logger.getRecentLogs()).toHaveLength(0);
    });
  });

  describe("timestamp format", () => {
    test("produces ISO-8601 timestamp", () => {
      logger.info("test");

      const timestamp = capturedLogs[0].timestamp;
      // Should match ISO format: 2024-01-23T12:34:56.789Z
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("formatted output", () => {
    test("getFormattedLogs returns string array", () => {
      logger.info("test message", { key: "value" });

      const formatted = logger.getFormattedLogs();
      expect(formatted).toHaveLength(1);
      expect(typeof formatted[0]).toBe("string");
      expect(formatted[0]).toContain("INFO");
      expect(formatted[0]).toContain("test message");
    });
  });
});
