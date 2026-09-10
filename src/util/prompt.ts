/**
 * Read a secret (e.g. an API key) from stdin without putting it in argv/history.
 * On a TTY it prompts and reads in raw mode with echo suppressed; when piped it
 * takes the first line.
 */

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const DEL = String.fromCharCode(127);
const BACKSPACE = String.fromCharCode(8);

export async function readSecret(promptText: string): Promise<string> {
  const stdin = process.stdin;

  // Piped / non-interactive: take the first line of stdin.
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]!.trim();
  }

  // Interactive TTY: raw mode, manual char handling, no echo.
  return new Promise<string>((resolve, reject) => {
    process.stderr.write(promptText);
    let input = "";

    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (data: string): void => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n" || ch === CTRL_D) {
          cleanup();
          process.stderr.write("\n");
          resolve(input.trim());
          return;
        }
        if (ch === CTRL_C) {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (ch === DEL || ch === BACKSPACE) {
          input = input.slice(0, -1);
        } else if (ch >= " ") {
          input += ch; // ignore other control chars
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

/**
 * Read one line of input. On a TTY it prompts on stderr and echoes; when piped
 * it takes the next line of stdin. Prompts go to stderr, like {@link readSecret},
 * so a command's real output stays pipeable.
 */
export async function readLine(promptText: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });
  try {
    return await new Promise<string>((resolve) => rl.question(promptText, resolve));
  } finally {
    rl.close();
    process.stdin.pause();
  }
}

/** One entry in a numbered picker. */
export interface PickChoice<T> {
  /** The line shown beside the number. */
  label: string;
  /** A second, dimmer line under it (model id, price, whatever disambiguates). */
  detail?: string;
  value: T;
}

/**
 * The universal disambiguation idiom (D-82, Joshua's call): **a numbered list
 * you answer with a number, never an error you retype past.**
 *
 * The other half is what happens with no terminal to ask on. It refuses — and
 * the refusal *names the flag that would have answered it*, with the choices
 * still listed, so an agent driving JLCode learns the invocation by being told
 * rather than by reading source. That is also how the Tier-0 tests drive the
 * real code path instead of a branch around it.
 */
export async function pickOne<T>(opts: {
  /** The question, e.g. `Several models match "claude":` */
  title: string;
  choices: PickChoice<T>[];
  /** The flag that answers this prompt, e.g. `--model <id>`. */
  flag: string;
  /** A concrete example of that flag, when one reads better than the shape. */
  example?: string;
}): Promise<T> {
  const { title, choices, flag } = opts;
  if (choices.length === 0) throw new Error(`${title}\n  (nothing to choose from)`);
  const listing = choices
    .map((c, i) => `  ${i + 1}. ${c.label}${c.detail ? `\n     ${c.detail}` : ""}`)
    .join("\n");
  if (process.stdin.isTTY !== true) {
    const example = opts.example ?? `${flag.split(" ")[0]} …`;
    throw new Error(
      `${title}\n${listing}\n` +
        `No terminal to ask on — re-run with ${flag} to answer this (e.g. ${example}).`,
    );
  }
  process.stderr.write(`${title}\n${listing}\n`);
  for (;;) {
    const answer = (await readLine(`Choose 1-${choices.length} (blank to cancel): `)).trim();
    if (answer === "") throw new Error("cancelled");
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
    process.stderr.write(`  "${answer}" is not one of 1-${choices.length}.\n`);
  }
}

/**
 * Ask for a value that has a sensible default. Unlike {@link pickOne} this does
 * **not** refuse without a TTY: a prompt whose answer can be derived is not an
 * ambiguity, it is a confirmation, and refusing one would make every scripted
 * invocation carry a flag that changes nothing. The flag still exists for the
 * cases where the default is wrong.
 */
export async function readLineOr(promptText: string, fallback: string): Promise<string> {
  if (process.stdin.isTTY !== true) return fallback;
  const answer = (await readLine(`${promptText} [${fallback}]: `)).trim();
  return answer === "" ? fallback : answer;
}
