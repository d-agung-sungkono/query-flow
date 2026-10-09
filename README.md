# QueryFlow

QueryFlow adalah Chrome Extension untuk menjalankan query SQL di FASIH SQL Lab (dibangun dari dasar Superset) dan mengunduh hasilnya sebagai file Excel.

- Integrasi: FASIH Dashboard / FASIH SQL Lab
- Contoh penggunaan parameter: SE2026 — Sensus Ekonomi 2026
- Initiated by: D.Agung Sungkono

QueryFlow adalah utilitas independen, bukan produk atau dokumentasi resmi BPS/FASIH.

## Cara Pakai

### 1. Siapkan SQL

Simpan file `.sql` di dalam folder. Jika query ingin dijalankan sebagai satu batch, kelompokkan file-file tersebut dalam subfolder yang sama. Contoh:

```text
Query/
├── Agregat/
│   ├── tabel-1.sql
│   └── tabel-2.sql
└── Mikro/
    └── tabel-3.sql
```

QueryFlow mengimpor file SQL dalam subfolder. File `.sql` yang berada langsung di root folder pilihan diabaikan.

### 2. Impor folder

1. Buka QueryFlow, lalu klik **Import Folder SQL**.
2. Pilih folder `Query` (folder induk), bukan subfolder `Agregat` atau `Mikro`.
3. Setelah daftar folder dan query muncul, pilih query yang akan dijalankan. Semua query terpilih secara default.

QueryFlow menyimpan salinan lokal (snapshot). Jika isi file SQL berubah, impor folder lagi untuk memperbarui snapshot.

### 3. Buka SQL Lab

1. Buka [FASIH SQL Lab](https://fasih-dashboard.bps.go.id/superset/sqllab/) dan login.
2. Pilih database, schema, dan LIMIT yang sesuai.
3. Buka QueryFlow dari tab SQL Lab tersebut. Jangan tutup tab atau panel selama query berjalan.

### 4. Jalankan query

- Klik **Run** di samping satu file untuk menjalankan satu query.
- Klik **Run Folder** untuk menjalankan semua query yang dipilih dalam folder secara berurutan.
 Klik **Stop** untuk menghentikan proses. Hasil yang sudah diterima tetap diunduh sebagai Excel parsial atau ZIP parsial sesuai pengaturan folder.
- Klik nama file untuk melihat SQL; gunakan **Copy** untuk menyalin SQL dengan filter wilayah yang dipilih.

Hasil setiap query menjadi satu sheet Excel. Tanpa pemisahan kolom, hasil satu folder digabung dalam satu workbook; file besar dapat dipecah menjadi beberapa bagian bernomor. Jika satu query gagal, hasil yang sudah terkumpul tetap diunduh sebagai output parsial.

### Filter wilayah

### Pisahkan hasil menurut kolom

Di pengaturan setiap folder, isi **Pisahkan berdasarkan kolom** untuk membuat workbook terpisah bagi setiap nilai unik. Kolom kedua bersifat opsional; jika diisi, setiap kombinasi kedua nilai menjadi satu workbook. Nama yang dimasukkan harus tersedia pada header hasil semua query terpilih. Pencocokan mengabaikan huruf besar/kecil dan spasi di awal/akhir.

QueryFlow memeriksa header dari hasil SQL Lab saat query mulai, tanpa menjalankan query tambahan. Jika kolom tidak ditemukan atau nama header ambigu, batch berhenti sebelum menerima baris query tersebut. Nilai kolom yang kosong atau `NULL` masuk ke kelompok `(blank)`. Batas halaman SQL tidak memulai kelompok baru; nilai yang sama tetap masuk ke workbook yang sama lintas halaman dan file SQL.

Saat pemisahan aktif, setiap checkpoint diunduh sebagai ZIP berisi workbook per kelompok dan `manifest.json`. Simpan seluruh ZIP dengan run ID yang sama. Manifest checkpoint berstatus `in_progress`; ZIP terakhir berisi status `complete` atau `incomplete`. Jika batch gagal, ZIP checkpoint yang sudah diunduh tetap ada dan ZIP terakhir menandai kegagalan serta mencantumkan checkpoint sebelumnya. Status ini penting karena checkpoint lama tidak dapat ditarik kembali dari folder Downloads.

Filter wilayah hanya diterapkan pada SQL yang menggunakan parameter `filter_provinsi` dan `filter_kabupaten`. Isi kode provinsi (Level 1) atau kode kabupaten/kota (Level 2); jika Level 2 diisi, Level 1 tidak digunakan. Biarkan keduanya kosong untuk tidak menerapkan filter wilayah dari QueryFlow.

Contoh parameter dalam SQL:

```sql
WITH param_wilayah AS (
    SELECT
        '' AS filter_provinsi,
        '' AS filter_kabupaten
)
```

## Pengaturan Lanjutan

Di setiap folder, aktifkan **Advanced settings** untuk mengatur:

- **Mulai Baris**: mulai mengambil hasil dari nomor baris ini.
- **Maks Total Baris**: batas jumlah baris yang diambil; kosong berarti tanpa batas.
- **Download Excel Tiap X Baris**: unduh hasil bertahap untuk mengurangi risiko kehilangan hasil jika proses panjang terganggu.

Pengaturan disimpan per folder. Nilai default biasanya cukup untuk penggunaan biasa.

## Instalasi untuk Development

Perlu Node.js 20.19+ atau 22.12+.

```bash
npm install
npm run build
```

Di Chrome, buka `chrome://extensions`, aktifkan **Developer mode**, pilih **Load unpacked**, lalu pilih folder `dist/`. Setelah membangun ulang, klik **Reload** pada extension.

## Catatan

- SQL dijalankan melalui sesi FASIH SQL Lab yang sedang login. QueryFlow tidak meminta atau menyimpan username/password.
- File SQL sumber tidak diubah. Snapshot disimpan lokal di browser.
- QueryFlow menambahkan pengurutan default bila query belum memiliki `ORDER BY`. Untuk pagination yang konsisten, gunakan `ORDER BY` dengan kunci unik.
- Panel harus tetap terbuka selama proses berjalan. Fitur resume belum tersedia; menjalankan ulang folder akan mengulang query dari awal.
- Versi ini ditujukan untuk FASIH SQL Lab. Perubahan pada aplikasi FASIH/Superset dapat memengaruhi kompatibilitas.

## Changelog

### 0.3.5

- Tambah pilihan query untuk menjalankan hanya file yang dipilih dari sebuah folder.
- Tambah pengaturan per folder: baris awal, batas total baris, dan unduhan Excel berkala.
- Perbaiki pengambilan hasil besar agar transfer data SQL Lab dapat dilanjutkan per bagian.
- Tangani kondisi extension diperbarui saat panel atau service worker masih aktif.

### 0.3.4

- Tambah pengambilan hasil SQL bertahap untuk mendukung query dengan hasil besar.
- Tingkatkan ekspor Excel untuk menggabungkan hasil query dan menangani hasil parsial saat dihentikan atau terjadi error.
- Perbaiki urutan pagination serta pesan status saat query berjalan.

### 0.3.3

- Rilis awal QueryFlow untuk mengimpor kumpulan file SQL lokal dan menjalankannya di FASIH SQL Lab.
- Tambah filter parameter wilayah, eksekusi query per file atau per folder, dan ekspor hasil ke Excel.
