import * as yauzl from "yauzl";

/** Reads the named entries of a zip or jar, skipping any larger than `maxBytes`. Missing entries are left out. */
export function readZipEntries(file: string, names: string[], maxBytes: number): Promise<Map<string, Buffer>> {
  const wanted = new Set(names);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError || !zip) return reject(openError ?? new Error("jar를 열지 못했습니다."));
      const found = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (!wanted.has(entry.fileName) || entry.uncompressedSize > maxBytes) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("jar 항목을 읽지 못했습니다."));
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          stream.on("error", reject);
          stream.on("end", () => {
            found.set(entry.fileName, Buffer.concat(chunks));
            if (found.size === wanted.size) {
              zip.close();
              resolve(found);
            } else {
              zip.readEntry();
            }
          });
        });
      });
      zip.on("end", () => resolve(found));
      zip.readEntry();
    });
  });
}
