import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { resolveSplitColumnIndexes, SplitChunkedExport, validateSplitColumnInputs } from "./split-export";
import type { QueryResult } from "./excel";

const result = (filename: string, columns: string[], rows: unknown[][]): QueryResult => ({ filename, title: filename, columns, rows });
const serialize = async (results: QueryResult[]): Promise<Uint8Array> => new TextEncoder().encode(JSON.stringify(results));

function setup(checkpointRows = 0) {
  const downloads: { filename: string; bytes: Uint8Array }[] = [];
  const output = new SplitChunkedExport("Agregat/Kategori_A", "run-123", ["kab", "kategori"], {
    checkpointRows,
    serialize,
    downloadArchive: async (filename, bytes) => { downloads.push({ filename, bytes }); },
  });
  return { output, downloads };
}

async function readArchive(bytes: Uint8Array): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

describe("split export column resolution", () => {
  it("matches returned headers case-insensitively and trims whitespace", () => {
    expect(resolveSplitColumnIndexes([" KAB ", "KATEGORI"], ["kab", " kategori "], "a.sql")).toEqual([0, 1]);
  });

  it("fails when a configured header is absent or ambiguous", () => {
    expect(() => resolveSplitColumnIndexes(["kab", "nilai"], ["kategori"], "c.sql"))
      .toThrow(/kategori.*c\.sql.*kab, nilai/i);
    expect(() => resolveSplitColumnIndexes(["kab", " KAB "], ["kab"], "c.sql"))
      .toThrow(/ambigu.*c\.sql/i);
  });

  it("validates free-text inputs and rejects duplicates or a second-only value", () => {
    expect(validateSplitColumnInputs("", "category")).toMatch(/pertama/i);
    expect(validateSplitColumnInputs("KAB", " kab ")).toMatch(/berbeda/i);
    expect(validateSplitColumnInputs("KAB", "kategori")).toBeNull();
  });
});

describe("partitioned checkpoint ZIP export", () => {
  it("groups by a compound key across pages and SQL files", async () => {
    const { output, downloads } = setup();
    await output.append(result("q1.sql", ["kab", "kategori", "nilai"], [["3507", "F", 1], ["3507", "G", 2]]));
    await output.append(result("q1.sql", ["KAB", "KATEGORI", "nilai"], [["3507", "F", 3]]));
    await output.append(result("q2.sql", ["kab", "kategori", "nilai"], [["3507", "F", 4]]));
    await output.flush(true);

    expect(downloads).toHaveLength(1);
    const archive = await readArchive(downloads[0]!.bytes);
    const names = Object.keys(archive.files).filter((name) => name.endsWith(".xlsx"));
    expect(names).toHaveLength(2);
    const fWorkbookFile = archive.file(names.find((name) => name.includes("3507_f"))!);
    const fWorkbook = JSON.parse(await fWorkbookFile!.async("string")) as QueryResult[];
    expect(fWorkbook).toEqual([
      result("q1.sql", ["kab", "kategori", "nilai"], [["3507", "F", 1], ["3507", "F", 3]]),
      result("q2.sql", ["kab", "kategori", "nilai"], [["3507", "F", 4]]),
    ]);
    const manifest = JSON.parse(await archive.file("manifest.json")!.async("string")) as { status: string; rowsCollected: number };
    expect(manifest).toMatchObject({ status: "complete", rowsCollected: 4 });
  });

  it("keeps null and blank values in the same explicit group", async () => {
    const { output, downloads } = setup();
    await output.append(result("q.sql", ["kab", "kategori", "value"], [[null, "F", 1], ["  ", "F", 2]]));
    await output.flush(true);
    const archive = await readArchive(downloads[0]!.bytes);
    const names = Object.keys(archive.files).filter((name) => name.endsWith(".xlsx"));
    expect(names).toHaveLength(1);
    expect(names[0]).toContain("blank_f");
  });

  it("downloads checkpoint ZIPs and an incomplete manifest without deleting prior checkpoints", async () => {
    const { output, downloads } = setup(2);
    await output.append(result("q1.sql", ["kab", "kategori", "value"], [["3507", "F", 1], ["3507", "F", 2]]));
    expect(downloads).toHaveLength(1);
    const firstArchive = await readArchive(downloads[0]!.bytes);
    const firstManifest = JSON.parse(await firstArchive.file("manifest.json")!.async("string")) as { status: string };
    expect(firstManifest.status).toBe("in_progress");

    expect(() => output.validateHeaders("q3.sql", ["kab", "value"])).toThrow(/kategori.*q3\.sql/i);
    await output.flush(true, true, "Kolom pembagi kategori tidak ditemukan pada q3.sql.");
    expect(downloads).toHaveLength(2);
    expect(downloads[0]!.filename).toMatch(/run-123_part-001\.zip$/);
    expect(downloads[1]!.filename).toMatch(/run-123_part-002\.zip$/);
    const finalArchive = await readArchive(downloads[1]!.bytes);
    const finalManifest = JSON.parse(await finalArchive.file("manifest.json")!.async("string")) as { status: string; failure?: string; previousArchives: string[] };
    expect(finalManifest.status).toBe("incomplete");
    expect(finalManifest.failure).toMatch(/q3\.sql/);
    expect(finalManifest.previousArchives).toEqual([downloads[0]!.filename]);
  });

  it("can emit a ZIP-only failure receipt when no rows were accepted", async () => {
    const { output, downloads } = setup();
    await output.flush(true, true, "No result");
    const archive = await readArchive(downloads[0]!.bytes);
    const manifest = JSON.parse(await archive.file("manifest.json")!.async("string")) as { status: string; failure: string };
    expect(manifest).toMatchObject({ status: "incomplete", failure: "No result" });
    expect(Object.keys(archive.files)).toEqual(["manifest.json"]);
  });
});