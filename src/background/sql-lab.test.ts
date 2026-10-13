import { afterEach, expect, it, vi } from "vitest";
import { runInSqlLabChunk, stopSqlLabRun } from "./sql-lab";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(data: Record<string, unknown>[], state = "success") {
  vi.useFakeTimers();
  const queries: Record<string, unknown> = {};
  let sql = "";
  const editor = { getClientRects: () => [1], env: { editor: { setValue: (value: string) => { sql = value; }, clearSelection: () => {} } } };
  const node = { __reactFiber$test: { memoizedProps: { store: { getState: () => ({ sqlLab: { queries } }) } } } };
  const run = { textContent: "Run", disabled: false, getClientRects: () => [1], click: vi.fn(() => {
    queries["q1"] = { sql, state, results: { columns: [{ name: "id" }], data } };
  }) };
  vi.stubGlobal("document", { querySelectorAll: (selector: string) => selector === ".ace_editor" ? [editor] : selector === "button" ? [run] : [node] });
  vi.stubGlobal("window", { location: { origin: "https://example.test" }, postMessage: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  return { run };
}

it("returns a bounded prefix and signals more data even below the requested row count", async () => {
  const { run } = setup(Array.from({ length: 4 }, () => ({ id: "é".repeat(400_000) })));
  const promise = runInSqlLabChunk("select id from t", "run", "a.sql", 0, 9000, 1);
  await vi.advanceTimersByTimeAsync(300);
  const response = await promise;
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.rows).toHaveLength(2);
  expect(response.hasMore).toBe(false);
  expect(response.continuation).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(2 * 1024 * 1024);

  const continuation = await runInSqlLabChunk("select id from t", "run", "a.sql", 0, 9000, 2);
  expect(continuation).toMatchObject({ ok: true, continuation: false, hasMore: false });
  if (continuation.ok) expect(continuation.rows).toHaveLength(2);
  expect(run.click).toHaveBeenCalledTimes(1);
});

it("does not report a timed-out identified query as a successful empty result", async () => {
  setup([], "running");
  const promise = runInSqlLabChunk("select id from t", "run", "a.sql", 0, 9000, 1);
  await vi.advanceTimersByTimeAsync(240_300);
  expect(await promise).toMatchObject({ ok: false, message: expect.stringContaining("4 menit") });
});

it("marks an empty result as no-data only after SQL Lab query success", async () => {
  setup([]);
  const promise = runInSqlLabChunk("select id from t", "run", "a.sql", 0, 9000, 1);
  await vi.advanceTimersByTimeAsync(300);
  expect(await promise).toMatchObject({
    ok: true,
    message: "The query returned no data",
    columns: ["id"],
    rows: [],
    hasMore: false,
  });
});

it("keeps an empty result from a failed database query as an error", async () => {
  setup([], "failed");
  const promise = runInSqlLabChunk("select id from t", "run", "a.sql", 0, 9000, 1);
  await vi.advanceTimersByTimeAsync(300);
  expect(await promise).toMatchObject({ ok: false, message: "Query failed" });
});

it("honors cancellation before a new chunk starts", async () => {
  const { run } = setup([{ id: 1 }]);
  stopSqlLabRun("run");
  expect(await runInSqlLabChunk("select id from t", "run", "a.sql", 9000, 9000, 2)).toMatchObject({ ok: false, message: expect.stringContaining("dihentikan") });
  expect(run.click).not.toHaveBeenCalled();
});

it("keeps a result completed concurrently with cancellation", async () => {
  setup([{ id: 1 }]);
  const promise = runInSqlLabChunk("select id from t", "run", "a.sql", 0, 9000, 1);
  await vi.advanceTimersByTimeAsync(0);
  stopSqlLabRun("run");
  await vi.advanceTimersByTimeAsync(300);
  expect(await promise).toMatchObject({ ok: true, rows: [[1]], hasMore: false });
});
