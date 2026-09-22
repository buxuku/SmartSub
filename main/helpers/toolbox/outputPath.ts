import fs from 'fs';
import path from 'path';

/** Reserve a new output before asynchronous work; never overwrite a source or prior export. */
export function reserveToolboxOutput(desired: string): string {
  const parsed = path.parse(path.resolve(desired));
  for (let suffix = 0; suffix < 10000; suffix++) {
    const candidate = path.join(
      parsed.dir,
      `${parsed.name}${suffix ? `_${suffix + 1}` : ''}${parsed.ext}`,
    );
    try {
      const fd = fs.openSync(candidate, 'wx');
      fs.closeSync(fd);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Too many existing outputs for ${desired}`);
}

export function toolboxOutputDirectory(
  requested: string | undefined,
  source: string,
) {
  const directory = requested || path.dirname(source);
  if (!fs.statSync(directory).isDirectory())
    throw new Error(`Output is not a directory: ${directory}`);
  return directory;
}

export async function writeToolboxOutput(target: string, content: Buffer) {
  try {
    await fs.promises.writeFile(target, content);
  } catch (error) {
    await fs.promises.unlink(target).catch(() => {});
    throw error;
  }
}
