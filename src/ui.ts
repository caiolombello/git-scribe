import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type SelectItem = {
  label: string;
  value: string;
  details?: string[];
};

type SelectOptions = {
  pageSize?: number;
};

const isInteractive = (): boolean => {
  return Boolean(input.isTTY && output.isTTY && process.env.GIT_SCRIBE_NON_INTERACTIVE !== "1");
};

const clearScreen = (): void => {
  output.write("\x1b[2J\x1b[H");
};

const renderList = (
  title: string,
  items: SelectItem[],
  selectedIndex: number,
  selected: Set<number>,
  offset: number,
  pageSize: number,
  footer?: string
): void => {
  clearScreen();
  output.write(`${title}\n\n`);
  const end = Math.min(items.length, offset + pageSize);
  const maxRows = output.rows ?? 24;
  const headerRows = 3;
  const footerRows = 2;
  const pageInfoRows = 1;
  const detailBudget = Math.max(0, maxRows - (headerRows + footerRows + pageInfoRows + (end - offset)));

  for (let i = offset; i < end; i += 1) {
    const item = items[i];
    const isCurrent = i === selectedIndex;
    const isSelected = selected.has(i);
    const prefix = isSelected ? "[x]" : "[ ]";
    const pointer = isCurrent ? ">" : " ";
    output.write(`${pointer} ${prefix} ${item.label}\n`);
    if (isCurrent && item.details && item.details.length > 0) {
      const details = detailBudget > 0 ? item.details.slice(0, detailBudget) : [];
      for (const detail of details) {
        output.write(`    ${detail}\n`);
      }
    }
  }
  output.write(`\n[${offset + 1}-${end} of ${items.length}]\n`);
  output.write(footer ?? "Arrows to move, PgUp/PgDn to jump, space to toggle, enter to confirm, q to quit.\n");
};

const renderMenu = (
  title: string,
  items: SelectItem[],
  selectedIndex: number,
  offset: number,
  pageSize: number,
  footer?: string
): void => {
  clearScreen();
  output.write(`${title}\n\n`);
  const end = Math.min(items.length, offset + pageSize);
  const maxRows = output.rows ?? 24;
  const headerRows = 3;
  const footerRows = 2;
  const pageInfoRows = 1;
  const detailBudget = Math.max(0, maxRows - (headerRows + footerRows + pageInfoRows + (end - offset)));

  for (let i = offset; i < end; i += 1) {
    const item = items[i];
    const isCurrent = i === selectedIndex;
    const pointer = isCurrent ? ">" : " ";
    output.write(`${pointer} ${item.label}\n`);
    if (isCurrent && item.details && item.details.length > 0) {
      const details = detailBudget > 0 ? item.details.slice(0, detailBudget) : [];
      for (const detail of details) {
        output.write(`    ${detail}\n`);
      }
    }
  }
  output.write(`\n[${offset + 1}-${end} of ${items.length}]\n`);
  output.write(footer ?? "Arrows to move, PgUp/PgDn to jump, enter to confirm, q to quit.\n");
};

const resolvePageSize = (options?: SelectOptions): number => {
  if (options?.pageSize && options.pageSize > 0) {
    return Math.max(5, Math.floor(options.pageSize));
  }
  const rows = output.rows ?? 24;
  return Math.max(5, rows - 6);
};

const resolveOffset = (index: number, offset: number, pageSize: number, length: number): number => {
  if (length <= pageSize) {
    return 0;
  }
  if (index < offset) {
    return index;
  }
  if (index >= offset + pageSize) {
    return Math.min(length - pageSize, index - pageSize + 1);
  }
  return offset;
};

export const multiSelect = async (title: string, items: SelectItem[], defaults?: Set<number>, options?: SelectOptions): Promise<number[] | null> => {
  if (!isInteractive()) {
    return items.map((_, index) => index);
  }

  const selected = defaults ? new Set(defaults) : new Set<number>();
  let index = 0;
  let offset = 0;
  const pageSize = resolvePageSize(options);

  input.setRawMode(true);
  input.resume();

  offset = resolveOffset(index, offset, pageSize, items.length);
  renderList(title, items, index, selected, offset, pageSize);

  return new Promise((resolve) => {
    const onKey = (key: string): void => {
      if (key === "\u0003" || key.toLowerCase() === "q") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve([...selected]);
        return;
      }
      if (key === " ") {
        if (selected.has(index)) {
          selected.delete(index);
        } else {
          selected.add(index);
        }
      }
      if (key === "\u001b[A") {
        index = index <= 0 ? items.length - 1 : index - 1;
      }
      if (key === "\u001b[B") {
        index = index >= items.length - 1 ? 0 : index + 1;
      }
      if (key === "\u001b[5~") {
        index = Math.max(0, index - pageSize);
      }
      if (key === "\u001b[6~") {
        index = Math.min(items.length - 1, index + pageSize);
      }
      if (key.toLowerCase() === "a") {
        if (selected.size === items.length) {
          selected.clear();
        } else {
          selected.clear();
          items.forEach((_, idx) => selected.add(idx));
        }
      }
      offset = resolveOffset(index, offset, pageSize, items.length);
      renderList(title, items, index, selected, offset, pageSize);
    };

    const cleanup = (): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", handleData);
      clearScreen();
    };

    const handleData = (data: Buffer): void => onKey(data.toString("utf8"));
    input.on("data", handleData);
  });
};

export const singleSelect = async (title: string, items: SelectItem[], options?: SelectOptions): Promise<number | null> => {
  if (!isInteractive()) {
    return 0;
  }

  let index = 0;
  let offset = 0;
  const pageSize = resolvePageSize(options);

  input.setRawMode(true);
  input.resume();

  offset = resolveOffset(index, offset, pageSize, items.length);
  renderMenu(title, items, index, offset, pageSize);

  return new Promise((resolve) => {
    const onKey = (key: string): void => {
      if (key === "\u0003" || key.toLowerCase() === "q") {
        cleanup();
        resolve(null);
        return;
      }
      if (key === "\r" || key === "\n") {
        cleanup();
        resolve(index);
        return;
      }
      if (key === "\u001b[A") {
        index = index <= 0 ? items.length - 1 : index - 1;
      }
      if (key === "\u001b[B") {
        index = index >= items.length - 1 ? 0 : index + 1;
      }
      if (key === "\u001b[5~") {
        index = Math.max(0, index - pageSize);
      }
      if (key === "\u001b[6~") {
        index = Math.min(items.length - 1, index + pageSize);
      }
      offset = resolveOffset(index, offset, pageSize, items.length);
      renderMenu(title, items, index, offset, pageSize);
    };

    const cleanup = (): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", handleData);
      clearScreen();
    };

    const handleData = (data: Buffer): void => onKey(data.toString("utf8"));
    input.on("data", handleData);
  });
};

export const promptText = async (message: string): Promise<string> => {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(message);
  rl.close();
  return answer.trim();
};

export const promptYesNo = async (message: string, defaultValue = false): Promise<boolean> => {
  const suffix = defaultValue ? " [Y/n] " : " [y/N] ";
  const answer = await promptText(`${message}${suffix}`);
  if (!answer) {
    return defaultValue;
  }
  return answer.toLowerCase().startsWith("y");
};

export const promptMessageEdit = async (subject: string, body?: string): Promise<{ subject: string; body?: string } | null> => {
  output.write("\nSuggested commit message:\n\n");
  output.write(subject + "\n");
  if (body && body.trim().length > 0) {
    output.write("\n" + body.trim() + "\n");
  }
  output.write("\n");

  const action = await promptText("Accept, edit, or cancel? (a/e/c): ");
  if (action.toLowerCase() === "c") {
    return null;
  }
  if (action.toLowerCase() !== "e") {
    return { subject, body };
  }

  const newSubject = await promptText("New subject: ");
  if (!newSubject) {
    return null;
  }

  output.write("Enter body lines. Submit an empty line to finish.\n");
  const lines: string[] = [];
  while (true) {
    const line = await promptText("> ");
    if (!line) {
      break;
    }
    lines.push(line);
  }

  return { subject: newSubject, body: lines.join("\n") };
};

export type SelectItemType = SelectItem;
