import { promises as fs } from 'node:fs';

export async function readCommitMessage(messageFilePath) {
  const raw = await fs.readFile(messageFilePath, 'utf8');
  const beforeScissors = raw.split(/^# ------------------------ >8 ------------------------$/m)[0];

  const lines = beforeScissors
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'));

  const cleaned = lines.join('\n').trim();
  const firstParagraph = cleaned.split(/\n\s*\n/)[0]?.trim();

  return firstParagraph || 'Work update';
}
