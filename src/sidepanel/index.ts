import "./style.css";
import packageJson from "../../package.json";
import { ChunkedExport, collectQuery, EXPORT_CHECKPOINT_ROWS } from "../services/chunked-export";
import { SplitChunkedExport, validateSplitColumnInputs, type FolderExportOutput } from "../services/split-export";
import { applyWilayahConfig, extractSqlTitle } from "../services/sql";

let folderRunning = false;
import { loadFolderConfigs, loadSnapshot, loadWilayah, saveFolderConfigs, saveSnapshot, saveWilayah, type StoredFolderConfig } from "../services/storage";
import { groupSqlFiles, isSqlPath } from "../services/repository-sync/files";
import { addWilayahCode, validateWilayah } from "../services/wilayah";
import { TARGET, type ExtensionMessage, type RepositorySnapshot, type ScanResult, type SqlFile, type SqlRunProgress, type SqlChunkResponse, type SyncProgress, type WilayahConfig } from "../types";

let snapshot: RepositorySnapshot | null = null;
let wilayah: WilayahConfig = { level1: [], level2: [] };
let folderConfigs: Record<string, StoredFolderConfig> = {};
let progress: SyncProgress = { phase: "idle", message: "Not synced" };
let wilayahError = "";
const runProgressTargets = new Map<string, (progress: SqlRunProgress) => void>();

function isContextInvalidated(error: unknown): boolean {
  return error instanceof Error && /extension context invalidated/i.test(error.message);
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App container is missing.");

app.innerHTML = `
  <main class="panel">
    <header class="app-header">
      <div class="app-brandline">
        <span class="eyebrow">Chrome Extension</span>
        <span class="version-badge">v${packageJson.version}</span>
      </div>
      <h1>QueryFlow</h1>
      <p class="field-note">Integrasi · FASIH SQL Lab</p>
      <p class="field-note">Case 1 · SE2026 — Sensus Ekonomi 2026</p>
    </header>
    <section class="section" aria-labelledby="source-title">
      <div class="section-heading"><span>01</span><h2 id="source-title">Sumber SQL</h2></div>
      <div class="source-card">
        <p id="source-name" class="source-name">Belum ada folder SQL</p>
        <dl class="metadata">
          <div><dt>Branch</dt><dd id="branch">main</dd></div>
          <div><dt>Status</dt><dd id="status" class="status">Belum diimpor</dd></div>
          <div><dt>Commit</dt><dd id="commit">—</dd></div>
          <div><dt>File</dt><dd id="counts">0 SQL · 0 folder</dd></div>
          <div class="wide"><dt>Terakhir diperbarui</dt><dd id="synced-at">—</dd></div>
        </dl>
        <div id="progress" class="progress" aria-live="polite"></div>
        <div class="source-actions">
          <!-- Sync from GitLab sengaja dinonaktifkan. Sumber query aktif berasal dari impor folder lokal. -->
          <button id="import-folder" class="secondary-button" type="button">Import Folder SQL</button>
          <input id="folder-input" type="file" webkitdirectory multiple hidden />
        </div>
      </div>
    </section>
    <section class="section" aria-labelledby="wilayah-title">
      <div class="section-heading"><span>02</span><h2 id="wilayah-title">Filter Wilayah</h2></div>
      <div class="field">
        <label>Level 1 <span>/ Provinsi · kosong berarti semua</span></label>
        <div id="level1-list" class="code-list"></div>
        <div id="add-level1-row" class="add-row" hidden>
          <input id="new-level1" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PP)" />
          <button id="confirm-level1" type="button">Tambah</button>
        </div>
        <button id="show-level1-add" class="text-button" type="button">＋ Tambah Provinsi</button>
      </div>
      <div class="field">
        <label>Level 2 <span>/ Kabupaten/Kota · kosong berarti semua</span></label>
        <div id="level2-list" class="code-list"></div>
        <div id="add-level2-row" class="add-row" hidden>
          <input id="new-level2" inputmode="numeric" autocomplete="off" placeholder="kode wilayah (PPKK)" />
          <button id="confirm-level2" type="button">Tambah</button>
        </div>
        <button id="show-level2-add" class="text-button" type="button">＋ Tambah Kabupaten/Kota</button>
      </div>
      <p id="wilayah-error" class="error" aria-live="polite"></p>
      <p id="wilayah-mode" class="field-note"></p>
      <p id="wilayah-saved" class="saved" aria-live="polite"></p>
    </section>
    <section class="section groups-section" aria-labelledby="groups-title">
      <div class="section-heading"><span>03</span><h2 id="groups-title">Folder SQL</h2></div>
      <details class="run-guide">
        <summary><span class="help-icon">?</span><span>Panduan Run &amp; auto-loop</span></summary>
        <div class="run-guide-content">
          <p>Sekali Run, data diambil bertahap sampai selesai. Hasil besar otomatis diunduh menjadi beberapa file Excel bernomor.</p>
          <ul>
            <li>Tombol <strong>Run</strong> berubah menjadi <strong>Stop</strong> selama query berjalan.</li>
            <li>Editor SQL aktif akan diganti. Tetap buka tab SQL Lab dan side panel ini.</li>
            <li><strong>Stop</strong> atau error tetap mengunduh hasil yang sudah terkumpul sebagai Excel parsial.</li>
            <li>Opsi folder: atur baris awal (offset), batas total baris, dan pilih query yang ingin dijalankan.</li>
            <li><strong>Run Folder</strong> tetap mengunduh Excel parsial jika terjadi error atau dihentikan di tengah proses.</li>
          </ul>
        </div>
      </details>
      <div id="empty-groups" class="empty-state">Import folder SQL untuk melihat daftar query dan menjalankannya di FASIH SQL Lab.</div>
      <div id="groups" class="groups"></div>
    </section>
    <footer class="author-credit">Initiated by D. Agung Sungkono</footer>
  </main>
  <dialog id="preview-dialog">
    <div class="dialog-header"><div><span id="preview-path"></span><h3 id="preview-name"></h3></div><button id="close-preview" aria-label="Tutup">×</button></div>
    <pre id="preview-content"></pre>
  </dialog>
`;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

const syncButton = document.querySelector<HTMLButtonElement>("#sync");
const importButton = byId<HTMLButtonElement>("import-folder");
const folderInput = byId<HTMLInputElement>("folder-input");
const newLevel1Input = byId<HTMLInputElement>("new-level1");
const newLevel2Input = byId<HTMLInputElement>("new-level2");

async function initialize(): Promise<void> {
  [snapshot, wilayah, folderConfigs] = await Promise.all([loadSnapshot(), loadWilayah(), loadFolderConfigs()]);
  progress = snapshot
    ? { phase: "success", message: snapshot.repository.namespace === "local-folder" ? "Imported" : "Synced" }
    : { phase: "idle", message: "Belum diimpor" };
  render();
}

function render(): void {
  renderSource();
  renderWilayah();
  renderGroups();
}

function renderSource(): void {
  byId("source-name").textContent = snapshot?.repository.name ?? "Belum ada folder SQL";
  byId("branch").textContent = snapshot?.repository.branch ?? TARGET.defaultBranch;
  const status = byId("status");
  status.textContent = progress.phase === "success" ? `✓ ${progress.message}` : progress.message;
  status.className = `status status-${progress.phase}`;
  byId("commit").textContent = snapshot?.repository.commit?.slice(0, 8) ?? "—";
  byId("counts").textContent = `${snapshot?.repository.sqlCount ?? 0} SQL · ${snapshot?.groups.length ?? 0} folder`;
  byId("synced-at").textContent = snapshot ? formatDate(snapshot.repository.syncedAt) : "—";
  const progressElement = byId("progress");
  const showDetail = !["idle", "success"].includes(progress.phase);
  progressElement.textContent = showDetail
    ? `${progress.message}${progress.phase === "error" && snapshot ? " Last successful snapshot preserved." : ""}`
    : "";
  progressElement.classList.toggle("progress-error", progress.phase === "error");
  const busy = ["connecting", "scanning", "reading", "saving"].includes(progress.phase);
  if (syncButton) syncButton.disabled = busy;
  importButton.disabled = busy;
}

function renderWilayah(): void {
  renderCodeList("level1-list", "Level 1", wilayah.level1, (index, code) => updateCode("level1", index, code), (index) => removeCode("level1", index));
  renderCodeList("level2-list", "Level 2", wilayah.level2, (index, code) => updateCode("level2", index, code), (index) => removeCode("level2", index));
  byId("wilayah-error").textContent = wilayahError;
  byId("wilayah-mode").textContent = wilayah.level2.length > 0 && wilayah.level1.length > 0
    ? "Filter aktif: Kabupaten/Kota. Daftar provinsi diabaikan selama Level 2 terisi."
    : wilayah.level2.length > 0
      ? "Filter aktif: Kabupaten/Kota."
      : wilayah.level1.length > 0
        ? "Filter aktif: seluruh Kabupaten/Kota dalam provinsi terpilih."
        : "Filter wilayah kosong: semua wilayah akan dijalankan.";
}

function renderCodeList(
  elementId: string,
  label: string,
  codes: string[],
  update: (index: number, code: string) => void,
  removeCodeAt: (index: number) => void,
): void {
  const list = byId(elementId);
  list.replaceChildren();
  codes.forEach((code, index) => {
    const row = document.createElement("div");
    row.className = "code-row";
    const input = document.createElement("input");
    input.inputMode = "numeric";
    input.value = code;
    input.placeholder = label === "Level 1" ? "kode wilayah (PP)" : "kode wilayah (PPKK)";
    input.setAttribute("aria-label", `Kode ${label} ${index + 1}`);
    input.addEventListener("change", () => update(index, input.value));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Hapus ${code}`);
    remove.addEventListener("click", () => removeCodeAt(index));
    row.append(input, remove);
    list.append(row);
  });
}

function renderGroups(): void {
  const groupsElement = byId("groups");
  groupsElement.replaceChildren();
  byId("empty-groups").hidden = Boolean(snapshot?.groups.length);
  for (const group of snapshot?.groups ?? []) {
    const currentConfig = folderConfigs[group.path] ?? {};
    const allPaths = group.files.map((file) => file.path);
    const selectedPaths = new Set<string>(
      currentConfig.selectedPaths !== undefined
        ? currentConfig.selectedPaths.filter((path) => allPaths.includes(path))
        : allPaths
    );
    const configuredStartRow = typeof currentConfig.startRow === "number" && currentConfig.startRow >= 1 ? currentConfig.startRow : 1;
    const configuredMaxRows = typeof currentConfig.maxRows === "number" && currentConfig.maxRows > 0 ? currentConfig.maxRows : undefined;
    const configuredCheckpointRows = typeof currentConfig.checkpointRows === "number" && currentConfig.checkpointRows > 0
      ? Math.floor(currentConfig.checkpointRows)
      : EXPORT_CHECKPOINT_ROWS;
    let advancedSettings = typeof currentConfig.advancedSettings === "boolean"
      ? currentConfig.advancedSettings
      : configuredStartRow !== 1 || configuredMaxRows !== undefined || configuredCheckpointRows !== EXPORT_CHECKPOINT_ROWS;
    let startRow = advancedSettings ? configuredStartRow : 1;
    let maxRows = advancedSettings ? configuredMaxRows : undefined;
    let checkpointRows = advancedSettings ? configuredCheckpointRows : EXPORT_CHECKPOINT_ROWS;
    const configuredSplitColumns = Array.isArray(currentConfig.splitColumns) ? currentConfig.splitColumns : [];
    let splitColumn1 = typeof configuredSplitColumns[0] === "string" ? configuredSplitColumns[0] : "";
    let splitColumn2 = typeof configuredSplitColumns[1] === "string" ? configuredSplitColumns[1] : "";
    let splitEnabled = typeof currentConfig.splitEnabled === "boolean" ? currentConfig.splitEnabled : Boolean(splitColumn1);

    const details = document.createElement("details");
    details.className = "group";
    const summary = document.createElement("summary");
    const heading = document.createElement("span");
    heading.className = "group-name";
    const repeatedName = (snapshot?.groups ?? []).filter((candidate) => candidate.name === group.name).length > 1;
    heading.textContent = repeatedName ? group.path.replaceAll("/", " / ") : group.name;
    const meta = document.createElement("span");
    meta.className = "group-count";
    meta.textContent = `${group.path} · ${group.files.length} SQL file${group.files.length === 1 ? "" : "s"}`;
    summary.append(heading, meta);

    const files = document.createElement("div");
    files.className = "file-list";

    // Folder Options: Start Row & Max Rows, Query Selection
    const configBox = document.createElement("div");
    configBox.className = "folder-config-box";

    const advancedSettingsLabel = document.createElement("label");
    advancedSettingsLabel.className = "advanced-settings-toggle";
    const advancedSettingsInput = document.createElement("input");
    advancedSettingsInput.type = "checkbox";
    advancedSettingsInput.checked = advancedSettings;
    const advancedSettingsText = document.createElement("span");
    advancedSettingsText.textContent = "Advanced settings";
    advancedSettingsLabel.append(advancedSettingsInput, advancedSettingsText);

    const rowGroup = document.createElement("div");
    rowGroup.className = "config-row-group";
    const advancedSettingsContent = document.createElement("div");
    advancedSettingsContent.className = "advanced-settings-content";

    const startRowField = document.createElement("div");
    startRowField.className = "config-field";
    const startRowLabel = document.createElement("label");
    startRowLabel.textContent = "Mulai baris";
    const startRowInput = document.createElement("input");
    startRowInput.type = "number";
    startRowInput.min = "1";
    startRowInput.placeholder = "1 (awal)";
    startRowInput.value = String(startRow);
    startRowInput.title = "Baris awal pengambilan data (1-based offset)";
    startRowField.append(startRowLabel, startRowInput);

    const maxRowsField = document.createElement("div");
    maxRowsField.className = "config-field";
    const maxRowsLabel = document.createElement("label");
    maxRowsLabel.textContent = "Batas baris";
    const maxRowsInput = document.createElement("input");
    maxRowsInput.type = "number";
    maxRowsInput.min = "1";
    maxRowsInput.placeholder = "Semua (tanpa batas)";
    maxRowsInput.value = maxRows !== undefined ? String(maxRows) : "";
    maxRowsInput.title = "Total maksimal baris sebelum berhenti mengambil data";
    maxRowsField.append(maxRowsLabel, maxRowsInput);

    const checkpointRowsField = document.createElement("div");
    checkpointRowsField.className = "config-field";
    const checkpointRowsLabel = document.createElement("label");
    checkpointRowsLabel.textContent = "Unduh tiap X baris";
    const checkpointRowsInput = document.createElement("input");
    checkpointRowsInput.type = "number";
    checkpointRowsInput.min = "1";
    checkpointRowsInput.step = "10000";
    checkpointRowsInput.value = String(checkpointRows);
    checkpointRowsInput.title = "Unduh bagian Excel setelah jumlah baris ini terkumpul di folder";
    checkpointRowsField.append(checkpointRowsLabel, checkpointRowsInput);

    rowGroup.append(startRowField, maxRowsField, checkpointRowsField);

    const splitSettings = document.createElement("div");
    splitSettings.className = "split-settings";
    const splitSettingsLabel = document.createElement("label");
    splitSettingsLabel.className = "advanced-settings-toggle split-settings-toggle";
    const splitSettingsInput = document.createElement("input");
    splitSettingsInput.type = "checkbox";
    splitSettingsInput.checked = splitEnabled;
    const splitSettingsText = document.createElement("span");
    splitSettingsText.textContent = "Split Excel by column";
    splitSettingsLabel.append(splitSettingsInput, splitSettingsText);

    const splitColumnFields = document.createElement("div");
    splitColumnFields.className = "split-column-fields";
    const splitColumn1Field = document.createElement("div");
    splitColumn1Field.className = "config-field";
    const splitColumn1Label = document.createElement("label");
    splitColumn1Label.textContent = "Pisahkan berdasarkan kolom";
    const splitColumn1Input = document.createElement("input");
    splitColumn1Input.type = "text";
    splitColumn1Input.value = splitColumn1;
    splitColumn1Input.placeholder = "Contoh: kode_kabupaten";
    splitColumn1Input.autocomplete = "off";
    splitColumn1Input.setAttribute("aria-label", "Kolom pertama untuk memisahkan hasil Excel");
    splitColumn1Field.append(splitColumn1Label, splitColumn1Input);

    const splitColumn2Field = document.createElement("div");
    splitColumn2Field.className = "config-field split-column-field";
    const splitColumn2Label = document.createElement("label");
    splitColumn2Label.textContent = "Kolom kedua (opsional)";
    const splitColumn2Input = document.createElement("input");
    splitColumn2Input.type = "text";
    splitColumn2Input.value = splitColumn2;
    splitColumn2Input.placeholder = "Contoh: kategori";
    splitColumn2Input.autocomplete = "off";
    splitColumn2Input.setAttribute("aria-label", "Kolom kedua untuk memisahkan hasil Excel");
    splitColumn2Field.append(splitColumn2Label, splitColumn2Input);
    splitColumnFields.append(splitColumn1Field, splitColumn2Field);

    const splitColumnNote = document.createElement("p");
    splitColumnNote.className = "split-column-note";
    splitColumnNote.textContent = "Kolom pertama wajib; kolom kedua opsional. Nama kolom divalidasi dari hasil SQL.";
    splitSettings.append(splitSettingsLabel, splitColumnFields, splitColumnNote);
    advancedSettingsContent.append(rowGroup, splitSettings);

    const toolbar = document.createElement("div");
    toolbar.className = "config-selection-toolbar";
    const selectionBadge = document.createElement("span");
    selectionBadge.className = "selection-badge";

    const selectionActions = document.createElement("div");
    selectionActions.className = "selection-actions";
    const selectAllBtn = document.createElement("button");
    selectAllBtn.type = "button";
    selectAllBtn.className = "micro-btn";
    selectAllBtn.textContent = "Pilih Semua";
    const deselectAllBtn = document.createElement("button");
    deselectAllBtn.type = "button";
    deselectAllBtn.className = "micro-btn";
    deselectAllBtn.textContent = "Batal Semua";
    selectionActions.append(selectAllBtn, deselectAllBtn);

    toolbar.append(selectionBadge, selectionActions);
    configBox.append(advancedSettingsLabel, advancedSettingsContent, toolbar);

    const batch = document.createElement("button");
    batch.className = "secondary-button";
    const batchStatus = document.createElement("p");
    batchStatus.className = "progress";
    batchStatus.setAttribute("role", "status");

    const checkboxMap = new Map<string, { checkbox: HTMLInputElement; row: HTMLDivElement }>();

    const persistCurrentFolderConfig = async (): Promise<void> => {
      folderConfigs[group.path] = {
        selectedPaths: [...selectedPaths],
        advancedSettings,
        startRow,
        maxRows,
        checkpointRows,
        splitColumns: [splitColumn1.trim(), splitColumn2.trim()],
        splitEnabled,
      };
      try {
        await saveFolderConfigs(folderConfigs);
      } catch (error) {
        if (!isContextInvalidated(error)) {
          batchStatus.textContent = error instanceof Error ? error.message : "Konfigurasi folder gagal disimpan.";
        }
      }
    };

    const updateAdvancedSettingsState = (): void => {
      startRowInput.disabled = !advancedSettings;
      maxRowsInput.disabled = !advancedSettings;
      checkpointRowsInput.disabled = !advancedSettings;
      rowGroup.classList.toggle("is-disabled", !advancedSettings);
      advancedSettingsContent.hidden = !advancedSettings;
    };

    const updateSplitSettingsState = (): void => {
      splitColumnFields.hidden = !splitEnabled;
      splitColumn1Input.disabled = !splitEnabled;
      splitColumn2Input.disabled = !splitEnabled || !splitColumn1.trim();
      splitColumn2Field.classList.toggle("is-disabled", splitColumn2Input.disabled);
    };

    updateAdvancedSettingsState();
    updateSplitSettingsState();

    const updateSelectionDisplay = (): void => {
      const count = selectedPaths.size;
      selectionBadge.textContent = `${count} / ${group.files.length} query dipilih`;
      batch.textContent = `▶ Run Folder (${count}/${group.files.length}) → Excel`;
      batch.disabled = count === 0;
    };

    startRowInput.addEventListener("change", () => {
      const val = parseInt(startRowInput.value, 10);
      startRow = !isNaN(val) && val >= 1 ? val : 1;
      startRowInput.value = String(startRow);
      void persistCurrentFolderConfig();
    });

    maxRowsInput.addEventListener("change", () => {
      const val = parseInt(maxRowsInput.value, 10);
      maxRows = !isNaN(val) && val > 0 ? val : undefined;
      maxRowsInput.value = maxRows !== undefined ? String(maxRows) : "";
      void persistCurrentFolderConfig();
    });

    checkpointRowsInput.addEventListener("change", () => {
      const val = parseInt(checkpointRowsInput.value, 10);
      checkpointRows = !isNaN(val) && val > 0 ? val : EXPORT_CHECKPOINT_ROWS;
      checkpointRowsInput.value = String(checkpointRows);
      void persistCurrentFolderConfig();
    });

    splitColumn1Input.addEventListener("change", () => {
      splitColumn1 = splitColumn1Input.value.trim();
      updateSplitSettingsState();
      void persistCurrentFolderConfig();
    });
    splitColumn2Input.addEventListener("change", () => {
      splitColumn2 = splitColumn2Input.value.trim();
      void persistCurrentFolderConfig();
    });
    splitSettingsInput.addEventListener("change", () => {
      splitEnabled = splitSettingsInput.checked;
      updateSplitSettingsState();
      void persistCurrentFolderConfig();
    });

    advancedSettingsInput.addEventListener("change", () => {
      advancedSettings = advancedSettingsInput.checked;
      if (!advancedSettings) {
        startRow = 1;
        maxRows = undefined;
        checkpointRows = EXPORT_CHECKPOINT_ROWS;
        startRowInput.value = String(startRow);
        maxRowsInput.value = "";
        checkpointRowsInput.value = String(checkpointRows);
      }
      updateAdvancedSettingsState();
      void persistCurrentFolderConfig();
    });

    selectAllBtn.addEventListener("click", () => {
      for (const file of group.files) {
        selectedPaths.add(file.path);
        const item = checkboxMap.get(file.path);
        if (item) {
          item.checkbox.checked = true;
          item.row.classList.remove("is-unselected");
        }
      }
      updateSelectionDisplay();
      void persistCurrentFolderConfig();
    });

    deselectAllBtn.addEventListener("click", () => {
      selectedPaths.clear();
      for (const file of group.files) {
        const item = checkboxMap.get(file.path);
        if (item) {
          item.checkbox.checked = false;
          item.row.classList.add("is-unselected");
        }
      }
      updateSelectionDisplay();
      void persistCurrentFolderConfig();
    });

    updateSelectionDisplay();

    let batchRunId: string | null = null;
    let batchTabId: number | null = null;
    let batchStopRequested = false;
    let batchController = new AbortController();
    batch.addEventListener("click", async () => {
      if (folderRunning) {
        if (!batchRunId || batchTabId === null) {
          batchStatus.textContent = "Run Folder lain masih berjalan.";
          return;
        }
        batchStopRequested = true;
        batchController.abort();
        batch.disabled = true;
        batch.textContent = "■ Stopping…";
        void stopRun(batchRunId, batchTabId);
        return;
      }

      const filesToRun = group.files.filter((file) => selectedPaths.has(file.path));
      if (filesToRun.length === 0) {
        batchStatus.textContent = "Pilih minimal 1 file SQL untuk dijalankan.";
        return;
      }
      splitColumn1 = splitColumn1Input.value.trim();
      splitColumn2 = splitColumn2Input.value.trim();
      const useSplitColumns = advancedSettings && splitEnabled;
      if (useSplitColumns) {
        const splitColumnsError = validateSplitColumnInputs(splitColumn1, splitColumn2);
        if (splitColumnsError) {
          batchStatus.textContent = splitColumnsError;
          return;
        }
      }
      const splitColumns = useSplitColumns ? [splitColumn1, splitColumn2].filter(Boolean) : [];
      await persistCurrentFolderConfig();

      folderRunning = true;
      batchStopRequested = false;
      batchController = new AbortController();
      batch.textContent = "■ Stop";
      batch.classList.add("stop-button");
      const output: FolderExportOutput = splitColumns.length
        ? new SplitChunkedExport(group.path, createRunId(), splitColumns, { checkpointRows })
        : new ChunkedExport(group.path, undefined, undefined, undefined, checkpointRows);
      batchStatus.classList.remove("progress-error", "progress-warning");
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
        batchTabId = tab.id;

        for (const [index, file] of filesToRun.entries()) {
          if (batchStopRequested) throw new Error("Run Folder dihentikan oleh pengguna.");
          batchStatus.textContent = `${index + 1}/${filesToRun.length}: ${file.name} — menunggu hasil. Tetap buka panel dan tab query ini.`;
          const runId = createRunId();
          batchRunId = runId;
          runProgressTargets.set(runId, (runProgress) => {
            batchStatus.textContent = `${index + 1}/${filesToRun.length}: ${file.name} — ${formatRunProgress(runProgress)}`;
          });
          let pending: Promise<SqlChunkResponse> | undefined;
          try {
            await collectQuery(
              (offset, _limit, iteration) => {
                batchStatus.textContent = `${index + 1}/${filesToRun.length}: ${file.name} — ${formatRunProgress({
                  runId,
                  path: file.path,
                  iteration,
                  state: "running",
                  rowsCollected: Math.max(0, offset - (startRow - 1)),
                })}`;
                pending = chrome.runtime.sendMessage({ type: "RUN_SQL_FILE", path: file.path, tabId: tab.id!, runId, offset, limit: _limit, iteration } satisfies ExtensionMessage) as Promise<SqlChunkResponse>;
                return pending;
              },
              (columns, rows) => output.append({ filename: file.path, title: extractSqlTitle(file.content, file.name), columns, rows }),
              () => batchStopRequested,
              (message) => { batchStatus.textContent = message; },
              batchController.signal,
              {
                startRow,
                maxRows,
                onColumns: (columns) => {
                  if (output instanceof SplitChunkedExport) output.validateHeaders(file.path, columns);
                },
              },
            );
          } finally {
            runProgressTargets.delete(runId);
            // Keep cancellation active until the outstanding request settles.
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tab.id!), () => clearRun(runId, tab.id!));
            // Keep the Stop action available between files and while exporting.
          }
        }
        await output.flush(true);
        const outputType = output instanceof SplitChunkedExport ? "file ZIP" : "file Excel";
        batchStatus.textContent = `Selesai: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.`;
      } catch (error) {
        batchStatus.textContent = await finishPartial(output, error);
      } finally {
        folderRunning = false;
        batchRunId = null;
        batchTabId = null;
        batchStopRequested = false;
        batch.disabled = false;
        updateSelectionDisplay();
        batch.classList.remove("stop-button");
      }
    });

    files.append(configBox, batch, batchStatus);

    for (const file of group.files) {
      const isSelected = selectedPaths.has(file.path);
      const row = document.createElement("div");
      row.className = `file-row ${isSelected ? "" : "is-unselected"}`;

      const checkTitle = document.createElement("div");
      checkTitle.className = "file-check-title";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "file-select-check";
      checkbox.checked = isSelected;
      checkbox.setAttribute("aria-label", `Pilih ${file.name}`);
      checkbox.title = "Pilih query ini untuk dijalankan pada Run Folder";

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selectedPaths.add(file.path);
          row.classList.remove("is-unselected");
        } else {
          selectedPaths.delete(file.path);
          row.classList.add("is-unselected");
        }
        updateSelectionDisplay();
        void persistCurrentFolderConfig();
      });

      checkboxMap.set(file.path, { checkbox, row });

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "file-title-btn";
      nameBtn.textContent = file.name;
      nameBtn.addEventListener("click", () => showPreview(file.name, file.path, file.content));

      checkTitle.append(checkbox, nameBtn);

      const actions = document.createElement("div");
      actions.className = "file-actions";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = "⧉ Copy";
      copy.title = "Salin SQL dengan filter wilayah aktif";

      const run = document.createElement("button");
      run.type = "button";
      run.textContent = "▶ Run";
      run.title = "Jalankan query dengan rentang baris yang dikonfigurasi; Stop mengunduh hasil parsial";
      const status = document.createElement("p");
      status.className = "progress";
      status.setAttribute("role", "status");

      let activeRun: { runId: string; tabId: number } | null = null;
      let stopRequested = false;
      let controller = new AbortController();
      copy.addEventListener("click", async () => {
        try {
          await copyText(applyWilayahConfig(file.content, wilayah));
          status.textContent = "SQL tersalin ke clipboard.";
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : "SQL gagal disalin.";
        }
      });

      run.addEventListener("click", async () => {
        if (activeRun) {
          stopRequested = true;
          controller.abort();
          run.disabled = true;
          run.textContent = "■ Stopping…";
          void stopRun(activeRun.runId, activeRun.tabId);
          return;
        }
        if (folderRunning) { status.textContent = "Tunggu Run Folder selesai."; return; }
        folderRunning = true;
        stopRequested = false;
        controller = new AbortController();
        const output = new ChunkedExport(file.path.replace(/\.sql$/i, ""), undefined, undefined, undefined, checkpointRows);
        status.textContent = "Mengirim SQL ke editor aktif...";
        const runId = createRunId();
        let tabId: number | undefined;
        let pending: Promise<SqlChunkResponse> | undefined;
        runProgressTargets.set(runId, (runProgress) => {
          status.textContent = formatRunProgress(runProgress);
        });
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id === undefined) throw new Error("Aktifkan tab FASIH SQL Lab.");
          tabId = tab.id;
          activeRun = { runId, tabId };
          run.textContent = "■ Stop";
          run.classList.add("stop-button");
          await collectQuery(
            (offset, _limit, iteration) => {
              status.textContent = formatRunProgress({
                runId,
                path: file.path,
                iteration,
                state: "running",
                rowsCollected: Math.max(0, offset - (startRow - 1)),
              });
              pending = chrome.runtime.sendMessage({ type: "RUN_SQL_FILE", path: file.path, tabId: tab.id!, runId, offset, limit: _limit, iteration } satisfies ExtensionMessage) as Promise<SqlChunkResponse>;
              return pending;
            },
            (columns, rows) => output.append({ filename: file.path, title: extractSqlTitle(file.content, file.name), columns, rows }),
            () => stopRequested,
            (message) => { status.textContent = message; },
            controller.signal,
            { startRow, maxRows },
          );
          await output.flush(true);
          status.textContent = `Selesai: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} file Excel diunduh.`;
        } catch (error) {
          status.textContent = await finishPartial(output, error);
        } finally {
          if (tabId !== undefined) {
            void (pending ?? Promise.resolve()).then(() => clearRun(runId, tabId!), () => clearRun(runId, tabId!));
          }
          folderRunning = false;
          runProgressTargets.delete(runId);
          activeRun = null;
          run.disabled = false;
          run.textContent = "▶ Run";
          run.classList.remove("stop-button");
        }
      });

      actions.append(copy, run);
      row.append(checkTitle, actions);
      files.append(row, status);
    }
    details.append(summary, files);
    groupsElement.append(details);
  }
}

async function persistWilayah(next: WilayahConfig): Promise<boolean> {
  const validation = validateWilayah(next);
  if (!validation.valid) {
    wilayahError = validation.errors[0] ?? "Konfigurasi wilayah tidak valid.";
    byId("wilayah-error").textContent = wilayahError;
    return false;
  }
  wilayah = next;
  wilayahError = "";
  try {
    await saveWilayah(wilayah);
  } catch (error) {
    if (isContextInvalidated(error)) return false;
    wilayahError = error instanceof Error ? error.message : "Konfigurasi wilayah gagal disimpan.";
    byId("wilayah-error").textContent = wilayahError;
    return false;
  }
  byId("wilayah-error").textContent = "";
  const saved = byId("wilayah-saved");
  saved.textContent = "Tersimpan";
  window.setTimeout(() => (saved.textContent = ""), 1200);
  return true;
}

async function updateCode(level: keyof WilayahConfig, index: number, code: string): Promise<void> {
  const next = [...wilayah[level]];
  next[index] = code.trim();
  await persistWilayah({ ...wilayah, [level]: next });
  renderWilayah();
}

async function removeCode(level: keyof WilayahConfig, index: number): Promise<void> {
  await persistWilayah({ ...wilayah, [level]: wilayah[level].filter((_, candidate) => candidate !== index) });
  renderWilayah();
}

async function confirmAdd(level: keyof WilayahConfig, input: HTMLInputElement, rowId: string): Promise<void> {
  const code = input.value.trim();
  const next = addWilayahCode(wilayah, level, code);
  if (next === wilayah) {
    const label = level === "level1" ? "Level 1" : "Level 2";
    wilayahError = wilayah[level].includes(code) ? `Kode ${label} tidak boleh duplikat.` : `Kode ${label} harus berisi angka.`;
    renderWilayah();
    return;
  }
  await persistWilayah(next);
  input.value = "";
  byId(rowId).hidden = true;
  renderWilayah();
}

function showPreview(name: string, path: string, content: string): void {
  byId("preview-name").textContent = name;
  byId("preview-path").textContent = path;
  byId("preview-content").textContent = content;
  byId<HTMLDialogElement>("preview-dialog").showModal();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function createRunId(): string {
  return crypto.randomUUID();
}

function formatRunProgress(progress: SqlRunProgress): string {
  const rows = new Intl.NumberFormat("id-ID").format(progress.rowsCollected);
  return progress.state === "running"
    ? `Proses ke-${progress.iteration} sedang berjalan · ${rows} baris terkumpul`
    : `Proses ke-${progress.iteration} selesai · ${rows} baris terkumpul`;
}

async function finishPartial(output: FolderExportOutput, error: unknown): Promise<string> {
  const reason = error instanceof Error ? error.message : "Run gagal.";
  try {
    await output.flush(true, true, reason);
    const outputType = output instanceof SplitChunkedExport ? "file ZIP" : "file Excel";
    return `${reason} ${output.parts ? `Hasil parsial: ${output.totalRows.toLocaleString("id-ID")} baris · ${output.parts} ${outputType} diunduh.` : "Belum ada hasil yang dapat diunduh."}`;
  } catch (exportError) {
    return `${reason} Ekspor sisa hasil gagal: ${exportError instanceof Error ? exportError.message : "Error Excel"}. ${output.parts} bagian sebelumnya sudah diunduh.`;
  }
}

async function clearRun(runId: string, tabId: number): Promise<void> {
  await chrome.runtime.sendMessage({ type: "CLEAR_SQL_RUN", runId, tabId } satisfies ExtensionMessage).catch(() => undefined);
}

async function stopRun(runId: string, tabId: number): Promise<{ ok: boolean; message: string }> {
  try {
    return await chrome.runtime.sendMessage({ type: "STOP_SQL_RUN", runId, tabId } satisfies ExtensionMessage) as { ok: boolean; message: string };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Query gagal dihentikan." };
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("SQL gagal disalin ke clipboard.");
}

// Handler dipertahankan agar fitur GitLab dapat diaktifkan kembali cukup dengan
// mengembalikan tombol #sync pada template di atas.
syncButton?.addEventListener("click", async () => {
  progress = { phase: "connecting", message: "Connecting to GitLab..." };
  renderSource();
  try {
    const result = (await chrome.runtime.sendMessage({ type: "SYNC_REPOSITORY" } satisfies ExtensionMessage)) as ScanResult;
    if (!result.ok) throw new Error(result.error);
    snapshot = result.snapshot;
    progress = { phase: "success", message: "Synced" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Sync failed" };
    renderSource();
  }
});

importButton.addEventListener("click", () => folderInput.click());
folderInput.addEventListener("change", () => void importRepositoryFolder(folderInput.files));

async function importRepositoryFolder(fileList: FileList | null): Promise<void> {
  if (!fileList?.length) return;
  const selected = [...fileList];
  const sqlFiles = selected.filter((file) => isSqlPath(file.name) && file.webkitRelativePath.split("/").length > 2);
  if (sqlFiles.length === 0) {
    progress = { phase: "error", message: "Tidak ada SQL dalam subfolder. SQL di root diabaikan; pilih folder repository yang membungkus query groups." };
    renderSource();
    folderInput.value = "";
    return;
  }

  const firstPath = selected[0]?.webkitRelativePath || selected[0]?.name || "repository";
  const rootFolder = firstPath.split("/")[0] || "repository";
  try {
    const importedFiles: SqlFile[] = [];
    for (const [index, file] of sqlFiles.entries()) {
      progress = {
        phase: "reading",
        message: `Reading ${index + 1} / ${sqlFiles.length} SQL files...`,
        current: index + 1,
        total: sqlFiles.length,
      };
      renderSource();
      const fullPath = file.webkitRelativePath || file.name;
      const relativePath = fullPath.startsWith(`${rootFolder}/`) ? fullPath.slice(rootFolder.length + 1) : fullPath;
      importedFiles.push({ name: file.name, path: relativePath, content: await file.text() });
    }

    const nextSnapshot: RepositorySnapshot = {
      version: 1,
      repository: {
        name: rootFolder,
        namespace: "local-folder",
        branch: "local import",
        syncedAt: new Date().toISOString(),
        sqlCount: importedFiles.length,
      },
      groups: groupSqlFiles(importedFiles),
    };
    progress = { phase: "saving", message: "Mengganti seluruh cache SQL dengan folder impor terbaru..." };
    renderSource();
    await saveSnapshot(nextSnapshot);
    snapshot = nextSnapshot;
    progress = { phase: "success", message: "Imported — cache lama diganti" };
    render();
  } catch (error) {
    progress = { phase: "error", message: error instanceof Error ? error.message : "Import folder gagal." };
    renderSource();
  } finally {
    folderInput.value = "";
  }
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "SQL_RUN_PROGRESS") {
    runProgressTargets.get(message.progress.runId)?.(message.progress);
    return;
  }
  if (message.type !== "SYNC_PROGRESS") return;
  progress = message.progress;
  renderSource();
});

byId("show-level1-add").addEventListener("click", () => {
  byId("add-level1-row").hidden = false;
  newLevel1Input.focus();
});
byId("confirm-level1").addEventListener("click", () => void confirmAdd("level1", newLevel1Input, "add-level1-row"));
newLevel1Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level1", newLevel1Input, "add-level1-row");
});
byId("show-level2-add").addEventListener("click", () => {
  byId("add-level2-row").hidden = false;
  newLevel2Input.focus();
});
byId("confirm-level2").addEventListener("click", () => void confirmAdd("level2", newLevel2Input, "add-level2-row"));
newLevel2Input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void confirmAdd("level2", newLevel2Input, "add-level2-row");
});
byId("close-preview").addEventListener("click", () => byId<HTMLDialogElement>("preview-dialog").close());

void initialize().catch((error: unknown) => {
  if (isContextInvalidated(error)) {
    const status = document.getElementById("status");
    if (status) status.textContent = "Extension diperbarui. Tutup lalu buka kembali panel QueryFlow.";
    return;
  }
  progress = { phase: "error", message: error instanceof Error ? error.message : "QueryFlow gagal dimuat." };
  renderSource();
});
