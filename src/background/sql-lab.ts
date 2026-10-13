import type { SqlChunkResponse } from "../types";

/** Executes one bounded page in MAIN world. All runtime helpers must remain inside this function. */
export async function runInSqlLabChunk(baseSql: string, runId: string, path: string, offset: number, limit: number, iteration: number): Promise<SqlChunkResponse> {
  const runtimeWindow = window as typeof window & {
    __queryFlowCancelledRuns?: Record<string, boolean>;
    __queryFlowPageCursors?: Record<string, { offset: number; queryId: string; nextRow: number; pageEnd: number; hasMore: boolean }>;
  };
  runtimeWindow.__queryFlowCancelledRuns ??= {};
  runtimeWindow.__queryFlowPageCursors ??= {};

  function throwIfCancelled(): void {
    if (runtimeWindow.__queryFlowCancelledRuns?.[runId]) {
      throw new Error("Run dihentikan oleh pengguna.");
    }
  }
  
  // Helper to check if ORDER BY exists strictly at the top level (depth 0, outside subqueries/CTEs)
  function hasTopLevelOrderBy(sql: string): boolean {
    let depth = 0;
    const upper = sql.toUpperCase();
    for (let i = 0; i < upper.length; i++) {
      const char = upper[i];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (depth === 0) {
        if (upper.substring(i, i + 8) === 'ORDER BY') {
          return true;
        }
      }
    }
    return false;
  }

  // Keep an explicit outer ORDER BY. Otherwise use the first output column by
  // position: guessing an identifier from a CTE/SELECT expression can reference
  // a column that is not exposed by the outer query.
  function ensureOrderBy(sql: string): string {
    if (hasTopLevelOrderBy(sql)) {
      return sql; // Outer/main query already has a top-level ORDER BY
    }

    const modified = sql.trim().replace(/;$/, "");
    return `${modified} ORDER BY 1 ASC`;
  }

  // Preserve high-precision SQL values before executeScript's structured clone
  // strips the BigNumber/Decimal prototype and leaves only fields such as c/e/s.
  function normalizeResultValue(value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (!value || typeof value !== "object") return value;

    const candidate = value as { c?: unknown; e?: unknown; s?: unknown; toString?: () => string };
    const isHighPrecisionNumber = Array.isArray(candidate.c)
      && typeof candidate.e === "number"
      && (candidate.s === 1 || candidate.s === -1);
    if (!isHighPrecisionNumber || typeof candidate.toString !== "function") return value;

    const rendered = candidate.toString();
    return rendered === "[object Object]" ? value : rendered;
  }

  // Preserve explicit ordering; fall back to output-column order for stable pagination.
  const preparedSql = ensureOrderBy(baseSql);
  const cleanSql = preparedSql.trim().replace(/;$/, "");

  function reportProgress(state: "running" | "completed", iter: number, rowsCollected: number, batchRows?: number): void {
    window.postMessage({
      source: "queryflow-sql-run-progress",
      progress: { runId, path, iteration: iter, state, rowsCollected, batchRows },
    }, window.location.origin);
  }

  type Query = { id?: string; sql?: string; state?: string; errorMessage?: string; errors?: unknown[]; results?: { columns?: { name: string }[]; data?: Record<string, unknown>[] }; rows?: number };
  type Store = { getState(): { sqlLab?: { queries?: Record<string, Query> } } };

  function takeRows(columns: string[], data: Record<string, unknown>[], start: number, end: number): unknown[][] {
    const rows: unknown[][] = [];
    const encoder = new TextEncoder();
    const maxBytes = 2 * 1024 * 1024;
    let bytes = encoder.encode(JSON.stringify(columns)).byteLength + 4096;
    if (bytes >= maxBytes) throw new Error("Header hasil melebihi batas transfer 2 MiB.");
    for (let index = start; index < end; index++) {
      const row = data[index];
      if (!row) break;
      const values = columns.map((name) => normalizeResultValue(row[name] ?? null));
      const rowBytes = encoder.encode(JSON.stringify(values)).byteLength + 1;
      if (bytes + rowBytes > maxBytes) {
        if (rows.length === 0) throw new Error("Satu baris melebihi batas transfer 2 MiB.");
        break;
      }
      rows.push(values);
      bytes += rowBytes;
    }
    return rows;
  }

  {
    const paginatedSql = `${cleanSql} LIMIT ${limit} OFFSET ${offset};`;
    reportProgress("running", iteration, offset);

    try {
      throwIfCancelled();
      let store: Store | undefined;
      for (const node of document.querySelectorAll("#app, #root, #app *")) {
        const key = Object.keys(node).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
        if (!key) continue;
        let fiber = (node as unknown as Record<string, unknown>)[key] as { return?: unknown; memoizedProps?: { store?: Store; value?: { store?: Store } } } | undefined;
        for (let depth = 0; fiber && depth < 100; depth++) {
          const candidate = fiber.memoizedProps?.store ?? fiber.memoizedProps?.value?.store;
          if (candidate?.getState()?.sqlLab?.queries) { store = candidate; break; }
          fiber = fiber.return as typeof fiber;
        }
        if (store) break;
      }
      if (!store) throw new Error("State hasil SQL Lab belum dikenali. Run dibatalkan.");

      const pageCursor = runtimeWindow.__queryFlowPageCursors?.[runId];
      if (pageCursor?.offset === offset) {
        const query = store.getState().sqlLab?.queries?.[pageCursor.queryId];
        const columns = query?.results?.columns?.map((column) => column.name);
        const data = query?.results?.data;
        if (!columns || !Array.isArray(data)) throw new Error("Hasil SQL Lab untuk chunk lanjutan sudah tidak tersedia.");
        const batchRows = takeRows(columns, data, pageCursor.nextRow, pageCursor.pageEnd);
        if (batchRows.length === 0) throw new Error("Chunk lanjutan tidak menghasilkan baris.");
        pageCursor.nextRow += batchRows.length;
        const continuation = pageCursor.nextRow < pageCursor.pageEnd;
        if (!continuation) delete runtimeWindow.__queryFlowPageCursors?.[runId];
        reportProgress("completed", iteration, pageCursor.nextRow, batchRows.length);
        return {
          ok: true,
          message: "Chunk diterima.",
          columns,
          rows: batchRows,
          hasMore: pageCursor.hasMore,
          continuation,
          pageSize: limit,
        };
      }

      const before = { ...store.getState().sqlLab?.queries };
      const visible = (element: HTMLElement): boolean => element.getClientRects().length > 0;
      const editors = [...document.querySelectorAll<HTMLElement>(".ace_editor")].filter(visible);
      if (editors.length !== 1) throw new Error("Pilih satu tab query SQL Lab dengan editor yang terlihat.");

      const element = editors[0] as HTMLElement & {
        env?: { editor?: {
          setValue(value: string, cursor: number): void;
          getValue(): string;
          clearSelection(): void;
        } };
      };

      const editor = element.env?.editor;
      if (!editor) throw new Error("Editor SQL Lab belum dapat diakses.");

      const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(visible);
      if (buttons.some((button) => /^stop(?: query)?$/i.test(button.textContent?.trim() ?? ""))) {
        throw new Error("Query masih berjalan. Tunggu selesai.");
      }

      editor.setValue(paginatedSql, -1);
      editor.clearSelection();
      
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

      const run = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .filter(visible).filter((button) => /^run(?: query)?$/i.test(button.textContent?.trim() ?? ""));
      if (run.length !== 1 || !run[0] || run[0].disabled) throw new Error("RUN belum siap.");
      
      throwIfCancelled();
      run[0].click();

      const deadline = Date.now() + 240_000;
      let queryId: string | undefined;
      let batchColumns: string[] = [];
      let batchRows: unknown[][] = [];
      let complete = false;
      let hasMore = false;
      let pageEnd = 0;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const queries = store.getState().sqlLab?.queries ?? {};
        if (!queryId) {
          const candidates = Object.entries(queries).filter(([id, query]) => !before[id] && query.sql?.trim() === paginatedSql.trim());
          queryId = candidates[0]?.[0];
        }

        const query = queryId ? queries[queryId] : undefined;
        if (!query || query.state !== "success") throwIfCancelled();
        if (!query) continue;
        if (["failed", "stopped", "timed_out"].includes(query.state ?? "")) throw new Error(query.errorMessage ?? `Query ${query.state}`);
        if (query.state !== "success") continue;
        if (query.errorMessage || (Array.isArray(query.errors) && query.errors.length > 0)) {
          throw new Error(query.errorMessage ?? "SQL Lab melaporkan error pada query.");
        }

        const cols = query.results?.columns?.map((column) => column.name);
        const data = query.results?.data;
        if (!cols || !Array.isArray(data)) {
          throwIfCancelled();
          continue;
        }

        batchColumns = cols;
        pageEnd = Math.min(data.length, limit);
        batchRows = takeRows(cols, data, 0, pageEnd);
        hasMore = data.length >= limit;
        const continuation = batchRows.length < pageEnd;
        if (continuation && queryId) {
          runtimeWindow.__queryFlowPageCursors[runId] = {
            offset,
            queryId,
            nextRow: batchRows.length,
            pageEnd,
            hasMore,
          };
        }
        complete = true;
        break;
      }

      if (!complete) {
        const stopButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.getClientRects().length > 0 && /^stop(?: query)?$/i.test(button.textContent?.trim() ?? ""));
        stopButton?.click();
        throw new Error("Batas tunggu 4 menit tercapai; hasil chunk belum tersedia.");
      }
      reportProgress("completed", iteration, offset + batchRows.length, batchRows.length);
      return {
        ok: true,
        message: batchRows.length === 0 ? "The query returned no data" : "Chunk diterima.",
        columns: batchColumns,
        rows: batchRows,
        hasMore,
        continuation: batchRows.length < pageEnd,
        pageSize: limit,
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Run gagal." };
    }
  }
}

/** Release cancellation state after the panel has finished exporting a run. */
export function clearSqlLabRun(runId: string): void {
  const runtimeWindow = window as typeof window & {
    __queryFlowCancelledRuns?: Record<string, boolean>;
    __queryFlowPageCursors?: Record<string, { offset: number; queryId: string; nextRow: number; pageEnd: number; hasMore: boolean }>;
  };
  delete runtimeWindow.__queryFlowCancelledRuns?.[runId];
  delete runtimeWindow.__queryFlowPageCursors?.[runId];
}

/** Marks a QueryFlow run as cancelled and presses SQL Lab's visible Stop button when available. */
export function stopSqlLabRun(runId: string): { ok: true; message: string } {
  const runtimeWindow = window as typeof window & { __queryFlowCancelledRuns?: Record<string, boolean> };
  runtimeWindow.__queryFlowCancelledRuns ??= {};
  runtimeWindow.__queryFlowCancelledRuns[runId] = true;

  const visible = (element: HTMLElement): boolean => element.getClientRects().length > 0;
  const stopButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter(visible)
    .find((button) => /^stop(?: query)?$/i.test(button.textContent?.trim() ?? ""));
  stopButton?.click();

  return {
    ok: true,
    message: stopButton ? "Menghentikan query aktif…" : "Permintaan stop dikirim…",
  };
}
