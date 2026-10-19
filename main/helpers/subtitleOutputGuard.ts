import fs from 'fs';
import path from 'path';

function isSameFile(first: string, second: string): boolean {
  if (path.resolve(first) === path.resolve(second)) return true;
  try {
    // bigint: a 64-bit file id does not survive being a double (NTFS), and two
    // neighbouring files could then look identical.
    const a = fs.statSync(first, { bigint: true });
    const b = fs.statSync(second, { bigint: true });
    // ino 0 means the volume has no stable file identity: nothing to compare.
    return a.ino !== BigInt(0) && a.ino === b.ino && a.dev === b.dev;
  } catch {
    // A file that does not exist yet cannot be another name for an existing one.
    return false;
  }
}

/**
 * Translation empties its output file before writing it. When that output is the very
 * subtitle being translated, the user's source would be erased, so refuse up front.
 * Besides the resolved paths the file identity is compared, because symlinks, hard
 * links and case-insensitive volumes name one file in several ways.
 */
export function assertOutputDoesNotOverwriteInput(
  output: string,
  inputs: Array<string | undefined>,
): void {
  if (inputs.some((input) => input && isSameFile(output, input)))
    throw new Error(
      `Translated subtitle would overwrite the source subtitle: ${output}. Choose different source and target file names.`,
    );
}
