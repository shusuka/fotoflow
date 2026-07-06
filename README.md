# 📸 FotoFlow — Sortir Foto Otomatis ala Fotografer

Terinspirasi Myflow (DOSS × Amlolife): memangkas waktu sortir ribuan foto dari berjam-jam jadi hitungan menit.

## Cara kerja

1. **Pilih Folder** — baca foto langsung dari folder di PC (termasuk sub-folder). Semua analisis berjalan **lokal di browser**, foto tidak pernah di-upload ke server.
2. **Sortir Otomatis** — tiap foto dinilai seperti mata fotografer:
   - **Ketajaman** (deteksi blur via variansi Laplacian)
   - **Eksposur** (histogram: gelap/over/kontras)
   - **Warna** (colorfulness Hasler–Süsstrunk)
   - **Foto mirip/burst dikelompokkan** (perceptual hash) — hanya juara grup yang terpilih
3. **Judul & Jadwal** — tulis caption yang enak dibaca + jadwal tayang otomatis berjarak.
4. **Salin ke PC** — foto terpilih disalin **persis file aslinya** (tanpa kompres ulang) ke folder output, dengan data judul/jadwal/skor disimpan **terpisah** di `fotoflow-data.json`.
5. **Upload Facebook** — penjadwalan posting ke Facebook Page via Graph API (`published=false` + `scheduled_publish_time`), minimal 10 menit s/d 75 hari ke depan.

## Syarat

- Browser **Chrome / Edge** di PC (butuh File System Access API)
- Untuk upload FB: **Page ID** + **Page Access Token** dengan izin `pages_manage_posts` (buat di [Graph API Explorer](https://developers.facebook.com/tools/explorer/)). Penjadwalan hanya untuk Page, bukan profil pribadi.

## Pengembangan

```bash
npm install
npm run dev     # jalankan lokal
npm run build   # build produksi (deploy ke Vercel)
```
