interface SampleFont {
  name: string;
  fullName?: string;
  postscriptName?: string;
  subtitlePath?: string | null;
  embeddedId?: string;
}
interface Entry {
  users: number;
  promise: Promise<string>;
  font?: FontFace;
}
const entries = new Map<string, Entry>();
let sequence = 0;

/** Share in-use faces only; closing or scrolling out releases browser font data. */
export function acquireFontSample(source: SampleFont) {
  const key = JSON.stringify(source);
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = { users: 0, promise: Promise.resolve('') };
    entry = created;
    entries.set(key, created);
    created.promise = (async () => {
      const family = `SmartSub-font-${++sequence}`;
      let font: FontFace | undefined;
      if (source.fullName) {
        const local = new FontFace(
          family,
          [source.postscriptName, source.fullName]
            .filter(Boolean)
            .map((name) => `local(${JSON.stringify(name)})`)
            .join(','),
        );
        try {
          font = await local.load();
        } catch {
          /* Fall back to font bytes. */
        }
      }
      if (!font) {
        const result = await window.ipc.invoke('subtitleMerge:getFontData', {
          fontName: source.name,
          subtitlePath: source.subtitlePath,
        });
        if (!result?.success || !result.data?.data?.length)
          throw new Error('Font unavailable');
        font = await new FontFace(
          family,
          new Uint8Array(result.data.data),
        ).load();
      }
      if (created.users > 0 && entries.get(key) === created) {
        created.font = font;
        document.fonts.add(font);
      }
      return family;
    })();
    void created.promise.catch(() => {
      if (entries.get(key) === created) entries.delete(key);
    });
  }
  const owned = entry;
  owned.users++;
  let released = false;
  return {
    promise: owned.promise,
    release() {
      if (released) return;
      released = true;
      if (--owned.users !== 0) return;
      if (owned.font) document.fonts.delete(owned.font);
      if (entries.get(key) === owned) entries.delete(key);
    },
  };
}
