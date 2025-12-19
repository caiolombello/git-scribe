import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type SelectItem = {
  label: string;
  value: string;
  details?: string[];
};

const clearScreen = (): void => {
  output.write("\x1b[2J\x1b[H");
};

const renderList = (title: string, items: SelectItem[], selectedIndex: number, selected: Set<number>, footer?: string): void => {
  clearScreen();
  output.write(`${title}\n\n`);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const isCurrent = i === selectedIndex;
    const isSelected = selected.has(i);
    const prefix = isSelected ? "[x]" : "[ ]";
    const pointer = isCurrent ? ">" : " ";
    output.write(`${pointer} ${prefix} ${item.label}\n`);
    if (isCurrent && item.details && item.details.length > 0) {
      for (const detail of item.details) {
        output.write(`    ${detail}\n`);
      }
    }
  }
  output.write("\n");
  output.write(footer ?? "Arrows to move, space to toggle, enter to confirm, q to quit.\n");
};

const renderMenu = (title: string, items: SelectItem[], selectedIndex: number, footer?: string): void => {
  clearScreen();
  output.write(`${title}\n\n`);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const isCurrent = i === selectedIndex;
    const pointer = isCurrent ? ">" : " ";
    output.write(`${pointer} ${item.label}\n`);
    if (isCurrent && item.details && item.details.length > 0) {
      for (const detail of item.details) {
        output.write(`    ${detail}\n`);
      }
    }
  }
  output.write("\n");
  output.write(footer ?? "Arrows to move, enter to confirm, q to quit.\n");
};

export const multiSelect = async (title: string, items: SelectItem[], defaults?: Set<number>): Promise<number[] | null> => {
  if (!input.isTTY || !output.isTTY) {
    return items.map((_, index) => index);
  }

  const selected = defaults ? new Set(defaults) : new Set<number>();
  let index = 0;

  input.setRawMode(true);
  input.resume();

  renderList(title, items, index, selected);

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
      if (key.toLowerCase() === "a") {
        if (selected.size === items.length) {
          selected.clear();
        } else {
          selected.clear();
          items.forEach((_, idx) => selected.add(idx));
        }
      }
      renderList(title, items, index, selected);
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

export const singleSelect = async (title: string, items: SelectItem[]): Promise<number | null> => {
  if (!input.isTTY || !output.isTTY) {
    return 0;
  }

  let index = 0;

  input.setRawMode(true);
  input.resume();

  renderMenu(title, items, index);

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
      renderMenu(title, items, index);
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
