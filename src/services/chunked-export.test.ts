import { describe, expect, it, vi } from "vitest";
import { ChunkedExport, collectQuery } from "./chunked-export";
import { serializeWorkbook, type QueryResult } from "./excel";
import type { SqlChunkResponse } from "../types";

const result = (rows: unknown[][], filename = "a.sql"): QueryResult => ({ filename, title: filename, columns: ["id"], rows });
const chunk = (rows: unknown[][], hasMore = false, continuation = false, pageSize?: number): SqlChunkResponse => ({
  ok: true,
  message: "OK",
  columns: ["id"],
  rows,
  hasMore,
  continuation,
  ...(pageSize === undefined ? {} : { pageSize }),
});

function downloads() {
  const saved: { path: string; results: QueryResult[] }[] = [];
  const serialize = vi.fn(async (results: QueryResult[]) => new TextEncoder().encode(JSON.stringify(results)));
  const download = vi.fn(async (path: string, buffer: Uint8Array) => { saved.push({ path, results: JSON.parse(new TextDecoder().decode(buffer)) as QueryResult[] }); });
  return { saved, download, serialize };
}

describe("combined Excel output", () => {
  it("uses compressed XLSX size even when raw data exceeds the old 8 MiB limit", async () => {
    const download = vi.fn<(path: string, buffer: Uint8Array) => Promise<void>>().mockResolvedValue(undefined);
    const serialize = vi.fn(serializeWorkbook);
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result(Array.from({ length: 1000 }, () => ["x".repeat(9000)])));
    await output.append(result([[2]], "b.sql"));
    await output.flush(true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download.mock.calls[0]?.[0]).toBe("folder");
    expect(download.mock.calls[0]?.[1].byteLength).toBeLessThan(20 * 1024 * 1024);
    expect(serialize.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it("does not split at old row or cell limits", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    const rows = Array.from({ length: 50_001 }, () => [1, 2, 3, 4, 5]);
    await output.append({ ...result(rows), columns: ["a", "b", "c", "d", "e"] });
    await output.flush(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.results[0]?.rows).toHaveLength(rows.length);
  });

  it("keeps retrieval chunks and multiple tables in one download", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[1], [2]]));
    await output.append(result([[3]]));
    await output.append(result([[4]], "b.sql"));
    expect(download).not.toHaveBeenCalled();
    await output.flush(true);
    expect(saved).toEqual([{ path: "folder", results: [result([[1], [2], [3]]), result([[4]], "b.sql")] }]);
  });

  it("splits only serialized output above the byte limit without losing or repeating rows", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, 170, serialize);
    const rows = Array.from({ length: 7 }, (_, i) => [String(i).repeat(30)]);
    await output.append(result(rows));
    await output.append(result([["last"]], "b.sql"));
    await output.flush(true);
    expect(saved.length).toBeGreaterThan(1);
    expect(saved.map((part, index) => part.path === `folder_part-${String(index + 1).padStart(3, "0")}`)).not.toContain(false);
    expect(download.mock.calls.every(([, buffer]) => buffer.byteLength <= 170)).toBe(true);
    expect(saved.flatMap((part) => part.results.flatMap((sheet) => sheet.rows))).toEqual([...rows, ["last"]]);
    expect(output.totalRows).toBe(8);
  });

  it("keeps output exactly at the byte limit in one file", async () => {
    const { saved, download, serialize } = downloads();
    const sheet = result([[1]]);
    const bytes = (await serialize([sheet])).byteLength;
    const output = new ChunkedExport("folder", download, bytes, serialize);
    await output.append(sheet);
    await output.flush(true);
    expect(saved.map((part) => part.path)).toEqual(["folder"]);
  });

  it("writes incremental checkpoints as numbered parts and releases completed rows", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize, 2);
    await output.append(result([[1]]));
    expect(download).not.toHaveBeenCalled();
    await output.append(result([[2]]));
    expect(saved).toEqual([{ path: "folder_part-001", results: [result([[1], [2]])] }]);
    await output.append(result([[3]]));
    await output.flush(true);
    expect(saved[1]).toEqual({ path: "folder_part-002", results: [result([[3]])] });
    expect(output.totalRows).toBe(3);
    expect(serialize).toHaveBeenCalledTimes(2);
  });

  it("exports prior tables plus the current partial table together", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[1]]));
    await output.append(result([[2]], "b.sql"));
    await output.flush(true, true);
    expect(saved).toEqual([{ path: "folder_partial", results: [result([[1]]), result([[2]], "b.sql")] }]);
  });

  it("preserves a buffer when download fails and avoids empty files before any result", async () => {
    const { saved, download, serialize } = downloads();
    download.mockRejectedValueOnce(new Error("disk"));
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.flush(true, true);
    expect(download).not.toHaveBeenCalled();
    await output.append(result([[1]]));
    await expect(output.flush(true)).rejects.toThrow("disk");
    await output.flush(true, true);
    expect(saved[0]?.results[0]?.rows).toEqual([[1]]);
    expect(output.parts).toBe(1);
  });
});

describe("automatic chunk collection", () => {
  it("downloads all accepted tables on Stop without waiting for the active request", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[1]]));
    const controller = new AbortController();
    let finish: (value: SqlChunkResponse) => void = () => {};
    const pending = new Promise<SqlChunkResponse>((resolve) => { finish = resolve; });
    const request = vi.fn<() => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[2]], true))
      .mockImplementationOnce(() => { controller.abort(); return pending; });
    await expect(collectQuery(request, (_, rows) => output.append(result(rows, "b.sql")), () => controller.signal.aborted, vi.fn(), controller.signal)).rejects.toThrow("dihentikan");
    await output.flush(true, true);
    expect(saved).toEqual([{ path: "folder_partial", results: [result([[1]]), result([[2]], "b.sql")] }]);
    finish(chunk([[3]]));
    await pending;
    expect(output.totalRows).toBe(2);
  });

  it("keeps a 9000-row SQL page offset fixed while transferring it in multiple messages", async () => {
    const request = vi.fn<(...args: number[]) => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[1], [2]], true, true, 9000))
      .mockResolvedValueOnce(chunk([[3], [4]], true, false, 9000))
      .mockResolvedValueOnce(chunk([], false, false, 9000));
    const accept = vi.fn(async () => {});
    await collectQuery(request, accept, () => false, vi.fn());
    expect(request.mock.calls).toEqual([[0, 9000, 1], [0, 9000, 2], [9000, 9000, 3]]);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("accepts a terminal empty result without trying to validate split headers", async () => {
    const request = vi.fn(async (): Promise<SqlChunkResponse> => ({
      ok: true,
      message: "The query returned no data",
      columns: [],
      rows: [],
      hasMore: false,
    }));
    const accept = vi.fn(async () => {});
    const onColumns = vi.fn();

    await expect(collectQuery(request, accept, () => false, vi.fn(), undefined, { onColumns })).resolves.toBeUndefined();

    expect(onColumns).not.toHaveBeenCalled();
    expect(accept).toHaveBeenCalledWith([], []);
  });

  it("does not treat an unconfirmed empty response as a successful query", async () => {
    const request = vi.fn(async (): Promise<SqlChunkResponse> => ({
      ok: true,
      message: "Chunk diterima.",
      columns: [],
      rows: [],
      hasMore: false,
    }));
    const accept = vi.fn(async () => {});

    await expect(collectQuery(request, accept, () => false, vi.fn())).rejects.toThrow(/without confirming.*The query returned no data/i);
    expect(accept).not.toHaveBeenCalled();
  });

  it("retries a failed SQL request at the same offset with a smaller query page", async () => {
    const request = vi.fn<(...args: number[]) => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce({ ok: false, message: "Response exceeded 64 MB" })
      .mockResolvedValueOnce(chunk([[1]], true, false, 4500))
      .mockResolvedValueOnce(chunk([[2]], false, false, 9000));
    await collectQuery(request, vi.fn(async () => {}), () => false, vi.fn());
    expect(request.mock.calls).toEqual([[0, 9000, 1], [0, 4500, 1], [4500, 9000, 2]]);
  });

  it("starts at the configured row and stops at the configured total row count", async () => {
    const request = vi.fn<(...args: number[]) => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[5], [6]], true, true, 3))
      .mockResolvedValueOnce(chunk([[7]], true, false, 3));
    const accept = vi.fn(async () => {});

    await collectQuery(request, accept, () => false, vi.fn(), undefined, { startRow: 5, maxRows: 3 });

    expect(request.mock.calls).toEqual([[4, 3, 1], [4, 3, 2]]);
    expect(accept).toHaveBeenCalledTimes(2);
  });

  it("exports accepted data after Stop, including a concurrently completed chunk", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    let stopped = false;
    const request = vi.fn(async () => { stopped = true; return chunk([[1], [2]], true); });
    await expect(collectQuery(request, (columns, rows) => output.append({ ...result(rows), columns }), () => stopped, vi.fn())).rejects.toThrow("dihentikan");
    await output.flush(true, true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(saved[0]?.results[0]?.rows).toEqual([[1], [2]]);
  });

  it("preserves earlier chunks when the next request fails and does not retry ordinary SQL errors", async () => {
    const { saved, download, serialize } = downloads();
    const output = new ChunkedExport("folder", download, undefined, serialize);
    await output.append(result([[0]], "previous.sql"));
    const request = vi.fn<() => Promise<SqlChunkResponse>>()
      .mockResolvedValueOnce(chunk([[1]], true))
      .mockRejectedValueOnce(new Error("Syntax error"));
    await expect(collectQuery(request, (_, rows) => output.append(result(rows)), () => false, vi.fn())).rejects.toThrow("Syntax error");
    await output.flush(true, true);
    expect(saved).toEqual([{ path: "folder_partial", results: [result([[0]], "previous.sql"), result([[1]])] }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("terminates retries even if a single row cannot be fetched", async () => {
    const request = vi.fn(async () => ({ ok: false as const, message: "Payload too large" }));
    await expect(collectQuery(request, vi.fn(), () => false, vi.fn())).rejects.toThrow("Payload too large");
    expect(request.mock.calls.length).toBeLessThan(16);
  });
});
