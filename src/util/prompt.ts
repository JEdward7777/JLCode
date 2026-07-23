/**
 * Read a secret (e.g. an API key) from stdin without putting it in argv/history.
 * On a TTY it prompts with the input masked; when piped it takes the first line.
 */
import readline from "node:readline";

export async function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]!.trim();
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stderr.write(promptText);
    // Suppress echo of typed characters (readline internal hook).
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}
