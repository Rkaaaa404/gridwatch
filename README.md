# GridWatch: Sistem Monitoring Distribusi Trafo Listrik

GridWatch adalah simulasi sistem monitoring real-time untuk jaringan distribusi trafo listrik. Proyek ini mendemonstrasikan implementasi protokol MQTT untuk memantau status operasional jaringan distribusi listrik dari gardu induk hingga trafo distribusi di daerah pelosok.

## Konsep Aplikasi

Pada jaringan kelistrikan nyata, energi dari Gardu Induk (tegangan tinggi) diturunkan ke Trafo Feeder, lalu didistribusikan ke Trafo Distribusi sebelum sampai ke konsumen akhir. Topologi jaringan ini membentuk hierarki (tree/chain). Masalah umum yang terjadi adalah ketika satu titik di tengah rantai mengalami gangguan (fault), seluruh node di bawahnya (downstream) akan kehilangan pasokan listrik.

GridWatch menyimulasikan sistem monitoring tersebut dengan memanfaatkan **protokol MQTT**. Setiap trafo dipresentasikan sebagai *node* yang saling terhubung sesuai dengan topologinya.

Fitur utama aplikasi ini:

1. **Cascade Fault Simulation**: Jika satu node di hulu (upstream) mengalami gangguan atau pemutusan daya, node di hilirnya (downstream) akan secara otomatis mendeteksi ketiadaan daya dan ikut melaporkan status pemadaman (NO_POWER).
2. **Auto-Recovery**: Sistem dapat pulih secara otomatis di sisi downstream ketika koneksi/pasokan daya dari upstream kembali normal.
3. **Real-Time Monitoring Dashboard**: Antarmuka web yang menampilkan peta distribusi, status kesehatan node (tegangan, arus, suhu, dan beban), log aktivitas, serta grafik historis secara real-time.
4. **Command Control Center**: Kemampuan untuk mengontrol status setiap trafo secara jarak jauh (TRIP, RESET, ISOLATE, FAULT).

---

## Alur Komunikasi dan Topologi (Node Flow)

Sistem ini mensimulasikan jaringan distribusi wilayah Sumatra Barat (Bukittinggi dan Kabupaten Agam) dengan skema *hierarchical tree* yang mengadaptasi arsitektur komunikasi data berjenjang (*multi-hop data relay*) untuk node di area pelosok.

**Alur Ketergantungan Daya & Komunikasi Data (Relay Flow):**

```text
Gardu Induk (Pusat)  <-- [Menerima semua data akhir]
 └── Trafo A         <-- [Meneruskan data dari B & C ke Pusat]
      ├── Trafo B    <-- [Meneruskan data D beserta datanya sendiri ke A]
      │    └── Trafo D <-- [Mengirim data ke B (Relay Node)]
      └── Trafo C    <-- [Mengirim data ke A]
```

**Daftar Node dan Role:**

1. **Gardu Induk** *(Bukittinggi)*
   - **Role:** Root Node / Gateway utama jaringan (150kV ke 20kV).
   - **Karakteristik:** Sumber daya utama, tidak bergantung pada node manapun.

2. **Trafo A** *(Kec. Matur)*
   - **Role:** Feeder Kecamatan (20kV ke 380V).
   - **Karakteristik:** Bergantung langsung pada Gardu Induk. Jika Gardu Induk mati, Trafo A kehilangan daya.

3. **Trafo B** *(Puncak Lawang)*
   - **Role:** Distribusi Desa (20kV ke 380V, 3-phase).
   - **Karakteristik:** Bergantung pada pasokan dari Trafo A.

4. **Trafo C** *(Desa Maninjau)*
   - **Role:** Distribusi Tepi Danau (20kV ke 220V).
   - **Karakteristik:** Bergantung secara paralel dengan Trafo B, mendapatkan daya dari Trafo A.

5. **Trafo D** *(Palembayan)*
   - **Role:** End Node Pelosok (Multi-hop Data Relay).
   - **Karakteristik:** Mensimulasikan node di area terpencil. **Data komunikasi dari Trafo D tidak dikirim langsung ke pusat, melainkan dikirim (di-relay) ke node atasnya (Trafo B).** Trafo B kemudian bertugas meneruskan data Trafo D beserta datanya sendiri ke node atasnya lagi (Trafo A), hingga akhirnya seluruh data terkumpul di Gardu Induk. (Bergantung juga secara daya pada Trafo B).

Selain node trafo (Publisher), terdapat role lain berupa:

- **Alert Engine (Subscriber)**: Berjalan di latar belakang memantau aliran data, mendeteksi anomali suhu/beban, dan menyebarkan alarm peringatan/kritis.
- **Dashboard Subscriber**: Berfungsi sebagai *bridge* (jembatan) antara broker MQTT dengan protokol WebSocket untuk meneruskan data secara langsung ke Web Browser UI.

---

## List Topik MQTT

Sistem ini menggunakan arsitektur topik ganda (Dual-Topic Architecture) untuk membedakan jalur komunikasi internal (relay estafet antar-node) dengan jalur komunikasi publik (ke pusat/dashboard).

### A. Topik Komunikasi Relay (Internal Uplink)

Digunakan khusus untuk komunikasi antar node dari hilir ke hulu. Node bawah tidak mem-publish data langsung ke pusat, melainkan "menitipkan" data ke node atasnya.

- **Format:** `relay/[upstreamId]/rx/[nodeId]/[jenis_data]`
- **Contoh:** `relay/trafo-b/rx/trafo-d/tegangan` (Trafo D mengirim data ke Trafo B).
- **Logika:** Node perantara (seperti Trafo A dan B) melakukan *subscribe* ke `relay/[id-mereka]/rx/#` untuk mendengarkan data dari bawahannya, lalu mengopernya (*forward*) ke atasan mereka. Gardu Induk sebagai Gateway bertugas menerima estafet terakhir dan menerjemahkannya kembali menjadi topik publik (`gridwatch/...`).

### B. Topik Publik / Pusat (Dashboard & Subscribers)

Topik akhir yang digunakan oleh Dashboard, Alert Engine, dan Pusat Kontrol.

**1. Topik Sensor / Telemetri (QoS 0, Retain: True)**
Digunakan untuk data kontinu.
- `gridwatch/[nodeId]/tegangan` : Nilai tegangan (V)
- `gridwatch/[nodeId]/arus` : Nilai arus (A)
- `gridwatch/[nodeId]/beban` : Persentase beban (%)
- `gridwatch/[nodeId]/suhu` : Suhu operasional trafo (°C)
- `gridwatch/[nodeId]/daya` : Daya aktif (kW)

**2. Topik Status & LWT (QoS 1, Retain: True)**
Menjamin pengiriman agar transisi status operasional terekam sistem.
- `gridwatch/[nodeId]/status` : Menyimpan state saat ini (`NORMAL`, `WARNING`, `FAULT`, `NO_POWER`, dll), role, dan info upstream.
- `gridwatch/[nodeId]/lwt` : Pesan *Last Will and Testament* (LWT) otomatis saat node mati/terputus.

**3. Topik Command & Alarm (QoS 2, Retain: False)**
Tingkat keandalan tertinggi untuk pesan kritikal (Control Downlink & Alarm).
- `gridwatch/kontrol/[nodeId]/cmd` : Menerima perintah jarak jauh (`TRIP`, `RESET`, `ISOLATE`, `FAULT`). Dikirim langsung via topik sentral agar segera dieksekusi tanpa delay relay.
- `gridwatch/kontrol/[nodeId]/ack` : Konfirmasi eksekusi perintah (acknowledgment).
- `gridwatch/[nodeId]/alarm` : Publikasi pesan kritis / bahaya dari trafo ke *Alert Engine* atau *Dashboard*.

---

## Fitur Lanjutan MQTT (MQTT v5 & v3.1.1)

Proyek ini mendemonstrasikan kelima konsep krusial dalam protokol MQTT:

1. **Topic Hierarchy & Wildcard**
   - Hierarki direpresentasikan lewat *Dual-Topic Architecture* (`relay/...` dan `gridwatch/...`).
   - *Wildcard* **`+`** (Single-level) digunakan di Alert Engine: `gridwatch/+/status`.
   - *Wildcard* **`#`** (Multi-level) digunakan di Dashboard Subscriber dan Node Perantara: `relay/[id]/rx/#`.
2. **Retained Message**
   - Seluruh data metrik sensor, *State* (Status), dan pesan LWT di-publish dengan `{ retain: true }`. Hal ini sangat penting agar *subscriber* baru (contoh: browser web baru di-refresh) langsung mendapatkan data terakhir tanpa menunggu trafo menembakkan paket berikutnya.
3. **Topic Alias (MQTT v5)**
   - Semua koneksi *publisher* dan *subscriber* telah di-upgrade menggunakan `protocolVersion: 5`.
   - Untuk menghemat *bandwidth* pada data frekuensi tinggi (sensor yang dikirim setiap detik), *publisher* menggunakan `topicAlias` bawaan MQTT v5 (ID 1-5 untuk tiap tegangan, arus, suhu, dsb.).
4. **Shared Subscription (MQTT v5)**
   - Alert Engine meng-subscribe pola grup `$share/alert-group/gridwatch/+/status`.
   - Hal ini memungkinkan *Load Balancing* jika sistem ini di-skalakan dengan menjalankan 2 atau lebih *Alert Engine* secara paralel, sehingga *broker* membagi pesan peringatan ke salah satunya secara adil (menghindari duplikasi).
5. **Flow Control / Batas In-Flight (MQTT v5)**
   - Pada `connectOptions` milik subscriber, parameter `properties: { receiveMaximum: 50 }` ditambahkan untuk mencegah *bottleneck* atau luapan memori dari *unacknowledged messages* (QoS 1/2) ketika beban komunikasi tinggi.

---

## Arsitektur Aplikasi

1. **Broker MQTT**: Pusat komunikasi (mendukung broker publik seperti EMQX atau layanan *cloud* seperti HiveMQ dengan otentikasi TLS).
2. **Publishers**: Skrip terpisah untuk setiap trafo.
3. **Subscribers**: Alert engine dan Dashboard Subscriber.
4. **Web UI**: Frontend HTML/CSS/JS (disajikan lewat Express Web Server).

## Cara Menjalankan Aplikasi

1. **Persiapan Folder:**

   ```bash
   cd gridwatch
   ```

2. **Instalasi Dependensi:**

   ```bash
   npm install
   ```

3. **Konfigurasi Cloud:**
   Menggunakan MQTT Broker HiveMQ ang membutuhkan kredensial

4. **Jalankan Aplikasi Utama:**
   Script di bawah akan menyalakan web server, subscriber, dan semua publisher node secara bersamaan:

   ```bash
   node run-all.js
   ```

5. **Akses Dashboard:**
   Buka web browser Anda di: `http://localhost:3000`

Di dashboard, Anda bisa melihat visualisasi cascade data secara langsung dan mencoba memutus daya (FAULT) pada node *upstream* (contoh: Trafo A) lalu mengamati bagaimana node *downstream* merespons secara otomatis (simulasi Auto-Recovery dan Mesh).
