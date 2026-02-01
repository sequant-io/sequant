/**
 * Centralized CLI UI module for Sequant
 *
 * Provides consistent styling, spinners, boxes, tables, and branding
 * with graceful fallbacks for non-TTY, CI, and legacy terminals.
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";
import boxen, { type Options as BoxenOptions } from "boxen";
// cli-table3 uses CommonJS `export =` syntax, default import works with esModuleInterop
import Table from "cli-table3";
import gradient from "gradient-string";
import { isCI, isStdoutTTY } from "./tty.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * UI configuration options
 */
export interface UIConfig {
  /** Disable all colors and styling */
  noColor: boolean;
  /** JSON output mode - suppress decorative output */
  jsonMode: boolean;
  /** Verbose mode - use text-only spinners to avoid overwriting output */
  verbose: boolean;
  /** Whether stdout is a TTY */
  isTTY: boolean;
  /** Running in CI environment */
  isCI: boolean;
  /** Minimal output mode */
  minimal: boolean;
}

/**
 * Global UI configuration state
 */
let config: UIConfig = {
  noColor: false,
  jsonMode: false,
  verbose: false,
  isTTY: isStdoutTTY(),
  isCI: isCI(),
  minimal: false,
};

/**
 * Configure UI settings
 *
 * Call this early in CLI startup to set global options.
 */
export function configureUI(options: Partial<UIConfig>): void {
  config = { ...config, ...options };

  // Check environment variables
  if (process.env.NO_COLOR || process.env.SEQUANT_MINIMAL === "1") {
    config.noColor = !!process.env.NO_COLOR;
    config.minimal = process.env.SEQUANT_MINIMAL === "1";
  }

  // Auto-configure for CI
  if (config.isCI && !options.minimal) {
    config.minimal = true;
  }
}

/**
 * Get current UI configuration
 */
export function getUIConfig(): Readonly<UIConfig> {
  return { ...config };
}

/**
 * Check if decorative output should be shown
 */
function shouldShowDecorative(): boolean {
  return !config.jsonMode && !config.minimal && config.isTTY;
}

/**
 * Check if animations should be used
 */
function shouldAnimate(): boolean {
  return (
    !config.jsonMode &&
    !config.verbose &&
    !config.isCI &&
    config.isTTY &&
    !config.noColor
  );
}

// ============================================================================
// Color Palette
// ============================================================================

/**
 * Standardized color palette for consistent styling
 */
export const colors = {
  // Semantic colors
  success: config.noColor ? (s: string) => s : chalk.green,
  error: config.noColor ? (s: string) => s : chalk.red,
  warning: config.noColor ? (s: string) => s : chalk.yellow,
  info: config.noColor ? (s: string) => s : chalk.blue,
  muted: config.noColor ? (s: string) => s : chalk.gray,

  // UI elements
  header: config.noColor ? (s: string) => s : chalk.blue.bold,
  label: config.noColor ? (s: string) => s : chalk.cyan,
  value: config.noColor ? (s: string) => s : chalk.white,
  accent: config.noColor ? (s: string) => s : chalk.cyan,
  bold: config.noColor ? (s: string) => s : chalk.bold,

  // Status colors
  pending: config.noColor ? (s: string) => s : chalk.gray,
  running: config.noColor ? (s: string) => s : chalk.cyan,
  completed: config.noColor ? (s: string) => s : chalk.green,
  failed: config.noColor ? (s: string) => s : chalk.red,
};

/**
 * Get color function respecting current config
 */
function getColor(colorFn: (s: string) => string): (s: string) => string {
  return config.noColor ? (s: string) => s : colorFn;
}

// ============================================================================
// Windows Compatibility
// ============================================================================

/**
 * Detect if running on legacy Windows terminal
 */
function isLegacyWindows(): boolean {
  return (
    process.platform === "win32" &&
    !process.env.WT_SESSION && // Not Windows Terminal
    !process.env.TERM_PROGRAM // Not VS Code terminal
  );
}

// ============================================================================
// ASCII Logo (Static - No figlet)
// ============================================================================

/**
 * Static ASCII logo for SEQUANT branding
 * Pre-generated to avoid ~1MB figlet font bundle
 */
const ASCII_LOGO = `
   _____ _____ _____ _   _ _____ _   _ _____
  /  ___/  ___|  _  | | | |  _  | \\ | |_   _|
  \\ \`--.\\ \`--.| | | | | | | | | |  \\| | | |
   \`--. \\\`--. \\ \\_/ / | | \\_| |_| . \` | | |
  /\\__/ /\\__/ /\\___/\\ |_| |\\___/\\_|\\_/ \\_/
  \\____/\\____/       \\___/
`.trimStart();

/**
 * Get the ASCII logo with optional gradient
 */
export function logo(): string {
  if (config.jsonMode || config.minimal) return "";
  if (config.noColor || !config.isTTY) return ASCII_LOGO;

  // Apply gradient for color terminals
  const sequantGradient = gradient(["#00D4FF", "#7B68EE", "#FF6B9D"]);
  return sequantGradient(ASCII_LOGO);
}

/**
 * Get the banner (logo + tagline)
 */
export function banner(): string {
  if (config.jsonMode || config.minimal) return "";

  const logoText = logo();
  const tagline = config.noColor
    ? "  Quantize your development workflow"
    : chalk.gray("  Quantize your development workflow");

  return `${logoText}\n${tagline}\n`;
}

// ============================================================================
// Spinners
// ============================================================================

/**
 * Spinner manager interface
 */
export interface SpinnerManager {
  /** Start the spinner with optional new text */
  start(text?: string): SpinnerManager;
  /** Mark as succeeded with optional message */
  succeed(text?: string): SpinnerManager;
  /** Mark as failed with optional message */
  fail(text?: string): SpinnerManager;
  /** Mark as warning with optional message */
  warn(text?: string): SpinnerManager;
  /** Stop the spinner */
  stop(): SpinnerManager;
  /** Update the spinner text */
  text: string;
  /** Check if spinner is active */
  isSpinning: boolean;
}

/**
 * Text-only spinner for verbose mode / non-TTY
 */
class TextSpinner implements SpinnerManager {
  public text: string;
  public isSpinning = false;

  constructor(initialText: string) {
    this.text = initialText;
  }

  start(text?: string): SpinnerManager {
    if (text) this.text = text;
    this.isSpinning = true;
    if (!config.jsonMode) {
      console.log(getColor(chalk.cyan)(`\u23F3 ${this.text}`));
    }
    return this;
  }

  succeed(text?: string): SpinnerManager {
    if (text) this.text = text;
    this.isSpinning = false;
    if (!config.jsonMode) {
      console.log(getColor(chalk.green)(`\u2713 ${this.text}`));
    }
    return this;
  }

  fail(text?: string): SpinnerManager {
    if (text) this.text = text;
    this.isSpinning = false;
    if (!config.jsonMode) {
      console.log(getColor(chalk.red)(`\u2717 ${this.text}`));
    }
    return this;
  }

  warn(text?: string): SpinnerManager {
    if (text) this.text = text;
    this.isSpinning = false;
    if (!config.jsonMode) {
      console.log(getColor(chalk.yellow)(`\u26A0 ${this.text}`));
    }
    return this;
  }

  stop(): SpinnerManager {
    this.isSpinning = false;
    return this;
  }
}

/**
 * Animated spinner wrapper
 */
class AnimatedSpinner implements SpinnerManager {
  private spinner: Ora;

  constructor(initialText: string) {
    this.spinner = ora({
      text: initialText,
      color: "cyan",
      spinner: "dots",
    });
  }

  get text(): string {
    return this.spinner.text;
  }

  set text(value: string) {
    this.spinner.text = value;
  }

  get isSpinning(): boolean {
    return this.spinner.isSpinning;
  }

  start(text?: string): SpinnerManager {
    if (text) this.spinner.text = text;
    this.spinner.start();
    return this;
  }

  succeed(text?: string): SpinnerManager {
    this.spinner.succeed(text);
    return this;
  }

  fail(text?: string): SpinnerManager {
    this.spinner.fail(text);
    return this;
  }

  warn(text?: string): SpinnerManager {
    this.spinner.warn(text);
    return this;
  }

  stop(): SpinnerManager {
    this.spinner.stop();
    return this;
  }
}

/**
 * Create a spinner with automatic fallback
 *
 * Returns an animated spinner for TTY, text-only for non-TTY/verbose/CI.
 */
export function spinner(text: string): SpinnerManager {
  if (shouldAnimate()) {
    return new AnimatedSpinner(text);
  }
  return new TextSpinner(text);
}

// ============================================================================
// Boxes
// ============================================================================

/**
 * Box style presets
 */
export type BoxStyle =
  | "success"
  | "error"
  | "warning"
  | "info"
  | "header"
  | "default";

/**
 * Get boxen options for a given style
 */
function getBoxOptions(style: BoxStyle): BoxenOptions {
  const baseOptions: BoxenOptions = {
    padding: 1,
    borderStyle: isLegacyWindows() ? "classic" : "round",
  };

  switch (style) {
    case "success":
      return {
        ...baseOptions,
        borderColor: config.noColor ? undefined : "green",
      };
    case "error":
      return {
        ...baseOptions,
        borderColor: config.noColor ? undefined : "red",
      };
    case "warning":
      return {
        ...baseOptions,
        borderColor: config.noColor ? undefined : "yellow",
      };
    case "info":
      return {
        ...baseOptions,
        borderColor: config.noColor ? undefined : "blue",
      };
    case "header":
      return {
        ...baseOptions,
        borderColor: config.noColor ? undefined : "cyan",
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
      };
    default:
      return baseOptions;
  }
}

/**
 * Create a boxed message
 */
export function box(content: string, style: BoxStyle = "default"): string {
  if (config.jsonMode) return "";
  if (!shouldShowDecorative()) {
    // Fallback to simple bordered output
    return content;
  }

  return boxen(content, getBoxOptions(style));
}

/**
 * Create a success box with title and message
 */
export function successBox(title: string, message: string): string {
  const content = `${getColor(chalk.green.bold)(`\u2705 ${title}`)}\n\n${message}`;
  return box(content, "success");
}

/**
 * Create an error box with title and message
 */
export function errorBox(title: string, message: string): string {
  const content = `${getColor(chalk.red.bold)(`\u274C ${title}`)}\n\n${message}`;
  return box(content, "error");
}

/**
 * Create a warning box with title and message
 */
export function warningBox(title: string, message: string): string {
  const content = `${getColor(chalk.yellow.bold)(`\u26A0\uFE0F  ${title}`)}\n\n${message}`;
  return box(content, "warning");
}

/**
 * Create a header box
 */
export function headerBox(title: string): string {
  const content = getColor(chalk.bold)(title);
  return box(content, "header");
}

// ============================================================================
// Tables
// ============================================================================

/**
 * Table column definition
 */
export interface TableColumn {
  /** Column header text */
  header: string;
  /** Column width (optional) */
  width?: number;
  /** Text alignment */
  align?: "left" | "center" | "right";
}

/**
 * Table options
 */
export interface TableOptions {
  /** Column definitions */
  columns: TableColumn[];
  /** Table style */
  style?: "default" | "compact" | "borderless";
}

/**
 * Create a formatted table
 */
export function table(
  rows: (string | number)[][],
  options: TableOptions,
): string {
  if (config.jsonMode) return "";

  const tableInstance = new Table({
    head: options.columns.map((col) =>
      config.noColor ? col.header : chalk.cyan.bold(col.header),
    ),
    colWidths: options.columns.map((col) => col.width ?? null),
    colAligns: options.columns.map((col) => col.align || "left"),
    style: {
      head: [],
      border: config.noColor ? [] : ["gray"],
    },
    chars: isLegacyWindows()
      ? {
          top: "-",
          "top-mid": "+",
          "top-left": "+",
          "top-right": "+",
          bottom: "-",
          "bottom-mid": "+",
          "bottom-left": "+",
          "bottom-right": "+",
          left: "|",
          "left-mid": "+",
          mid: "-",
          "mid-mid": "+",
          right: "|",
          "right-mid": "+",
          middle: "|",
        }
      : undefined,
  });

  for (const row of rows) {
    tableInstance.push(row.map(String));
  }

  return tableInstance.toString();
}

/**
 * Create a simple key-value table
 */
export function keyValueTable(data: Record<string, string | number>): string {
  if (config.jsonMode) return "";

  const rows = Object.entries(data).map(([key, value]) => [
    config.noColor ? key : chalk.cyan(key),
    String(value),
  ]);

  const tableInstance = new Table({
    style: {
      head: [],
      border: config.noColor ? [] : ["gray"],
    },
    chars: isLegacyWindows()
      ? {
          top: "-",
          "top-mid": "+",
          "top-left": "+",
          "top-right": "+",
          bottom: "-",
          "bottom-mid": "+",
          "bottom-left": "+",
          "bottom-right": "+",
          left: "|",
          "left-mid": "+",
          mid: "-",
          "mid-mid": "+",
          right: "|",
          "right-mid": "+",
          middle: "|",
        }
      : undefined,
  });

  for (const row of rows) {
    tableInstance.push(row);
  }

  return tableInstance.toString();
}

// ============================================================================
// Status Indicators
// ============================================================================

/**
 * Status indicator types
 */
export type StatusType =
  | "success"
  | "error"
  | "warning"
  | "pending"
  | "running";

/**
 * Get a status icon
 */
export function statusIcon(type: StatusType): string {
  if (config.noColor) {
    switch (type) {
      case "success":
        return "[OK]";
      case "error":
        return "[FAIL]";
      case "warning":
        return "[WARN]";
      case "pending":
        return "[ ]";
      case "running":
        return "[..]";
    }
  }

  switch (type) {
    case "success":
      return chalk.green("\u2713");
    case "error":
      return chalk.red("\u2717");
    case "warning":
      return chalk.yellow("\u26A0");
    case "pending":
      return chalk.gray("\u25CB");
    case "running":
      return chalk.cyan("\u25D0");
  }
}

/**
 * Print a status message with icon
 */
export function printStatus(type: StatusType, message: string): void {
  if (config.jsonMode) return;
  console.log(`${statusIcon(type)} ${message}`);
}

// ============================================================================
// Layout Utilities
// ============================================================================

/**
 * Create a horizontal divider
 */
export function divider(width = 50): string {
  if (config.jsonMode) return "";

  const char = isLegacyWindows() ? "-" : "\u2501";
  const line = char.repeat(width);
  return config.noColor ? line : chalk.gray(line);
}

/**
 * Create a section header
 */
export function sectionHeader(title: string): string {
  if (config.jsonMode) return "";

  const formattedTitle = config.noColor ? title : chalk.blue.bold(title);
  return `\n${formattedTitle}\n${divider(title.length + 4)}\n`;
}

// ============================================================================
// Progress & Phase Visualization
// ============================================================================

/**
 * Phase status for progress display
 */
export interface PhaseStatus {
  name: string;
  status: "pending" | "running" | "success" | "failure" | "skipped";
}

/**
 * Display phase progress as a visual indicator
 */
export function phaseProgress(phases: PhaseStatus[]): string {
  if (config.jsonMode) return "";

  const icons = phases.map((phase) => {
    switch (phase.status) {
      case "success":
        return config.noColor ? "[OK]" : chalk.green("\u25CF");
      case "failure":
        return config.noColor ? "[X]" : chalk.red("\u2717");
      case "running":
        return config.noColor ? "[..]" : chalk.cyan("\u25D0");
      case "skipped":
        return config.noColor ? "[-]" : chalk.gray("-");
      default:
        return config.noColor ? "[ ]" : chalk.gray("\u25CB");
    }
  });

  const labels = phases.map((phase) => phase.name.charAt(0).toUpperCase());

  return `  Phases: ${icons.join(" ")}\n          ${labels.join(" ")}`;
}

/**
 * Create a progress bar
 */
export function progressBar(
  current: number,
  total: number,
  width = 20,
): string {
  if (config.jsonMode) return "";

  const percentage = total > 0 ? current / total : 0;
  const filled = Math.round(percentage * width);
  const empty = width - filled;

  const filledChar = config.noColor || isLegacyWindows() ? "#" : "\u2588";
  const emptyChar = config.noColor || isLegacyWindows() ? "-" : "\u2591";

  const bar = filledChar.repeat(filled) + emptyChar.repeat(empty);
  return config.noColor
    ? bar
    : chalk.green(filledChar.repeat(filled)) +
        chalk.gray(emptyChar.repeat(empty));
}

// ============================================================================
// Unified UI Namespace
// ============================================================================

/**
 * Unified UI object for convenient access to all utilities
 */
export const ui = {
  // Config
  configure: configureUI,
  getConfig: getUIConfig,

  // Branding
  logo,
  banner,

  // Spinners
  spinner,

  // Boxes
  box,
  successBox,
  errorBox,
  warningBox,
  headerBox,

  // Tables
  table,
  keyValueTable,

  // Status
  statusIcon,
  printStatus,

  // Layout
  divider,
  sectionHeader,

  // Progress
  phaseProgress,
  progressBar,
};

export default ui;
