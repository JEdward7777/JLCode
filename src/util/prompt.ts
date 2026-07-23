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
