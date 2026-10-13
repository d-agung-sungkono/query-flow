import { expect, it, vi } from "vitest";
import { compareFilenames } from "./filename-order";
import { groupSqlFiles } from "../services/repository-sync/files";
import { loadSnapshot } from "../services/storage";
import { workbookFilename } from "../services/excel";

it("orders numeric filename segments and letter suffixes naturally", () => {
  expect(["Tabel10.sql", "Tabel2.sql", "Tabel1.sql"].sort(compareFilenames)).toEqual(["Tabel1.sql", "Tabel2.sql", "Tabel10.sql"]);
  expect(["q_1d.sql", "q_1b.sql", "q_1a.sql", "q_1c.sql"].sort(compareFilenames)).toEqual(["q_1a.sql", "q_1b.sql", "q_1c.sql", "q_1d.sql"]);
});

it("uses natural ordering for imports and restores older snapshots without modifying SQL", async () => {
  const files = ["q10.sql", "q2.sql", "q1.sql"].map((name) => ({ name, path: `Folder/${name}`, content: "SELECT 1;" }));
  expect(groupSqlFiles(files)[0]?.files.map((file) => file.name)).toEqual(["q1.sql", "q2.sql", "q10.sql"]);
  const snapshot = { version: 1, repository: { name: "test", namespace: "local-folder", branch: "local import", syncedAt: new Date().toISOString(), sqlCount: 3 }, groups: [{ name: "Folder", path: "Folder", files }] };
  vi.stubGlobal("chrome", { storage: { local: { get: async () => ({ repositorySnapshot: snapshot }) } } });
  try {
    const restored = await loadSnapshot();
    expect(restored?.groups[0]?.files.map((file) => file.name)).toEqual(["q1.sql", "q2.sql", "q10.sql"]);
    expect(files[0]?.name).toBe("q10.sql");
    expect(restored?.groups[0]?.files.every((file) => file.content === "SELECT 1;")).toBe(true);
  } finally { vi.unstubAllGlobals(); }
});

it("names workbooks after the selected folder", () => {
  expect(workbookFilename("Agregat/Kategori_A", false, "2026-10-13")).toBe("Agregat_Kategori_A_2026-10-13.xlsx");
  expect(workbookFilename("Mikro/Kategori_A/Hortikultura", false, "2026-10-13")).toBe("Mikro_Kategori_A_Hortikultura_2026-10-13.xlsx");
});
