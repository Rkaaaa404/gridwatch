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

Sistem ini mensimulasikan jaringan distribusi wilayah Sumatra Barat (Bukittinggi dan Kabupaten Agam) dengan skema *hierarchical tree* yang juga mengadaptasi arsitektur jaringan *mesh* (seperti LoRa relay) untuk node pelosok.

**Alur Ketergantungan Daya (Cascade Flow):**
```text
Gardu Induk (Pusat)
 └── Trafo A
      ├── Trafo B
      │    └── Trafo D
      └── Trafo C
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
   - **Role:** End Node Pelosok (LoRa Relay / Mesh Topology).
   - **Karakteristik:** Bergantung pada Trafo B. Mensimulasikan area terpencil yang koneksinya (dan dayanya) di-*relay* melalui Trafo B.

Selain node trafo (Publisher), terdapat role lain berupa:
- **Alert Engine (Subscriber)**: Berjalan di latar belakang memantau aliran data, mendeteksi anomali suhu/beban, dan menyebarkan alarm peringatan/kritis.
- **Dashboard Subscriber**: Berfungsi sebagai *bridge* (jembatan) antara broker MQTT dengan protokol WebSocket untuk meneruskan data secara langsung ke Web Browser UI.

---

## List Topik MQTT

Sistem ini mendemonstrasikan variasi penggunaan *Quality of Service (QoS)* dan *Retained Messages* pada topik yang berbeda:

### 1. Topik Sensor / Telemetri (QoS 0, Retain: True)
Digunakan untuk data kontinu. Hilangnya sebagian kecil pesan tidak memengaruhi kestabilan sistem. Pesan disimpan (retain) agar *subscriber* baru langsung mendapat data terakhir.
- `gridwatch/[nodeId]/tegangan` : Nilai tegangan (V)
- `gridwatch/[nodeId]/arus` : Nilai arus (A)
- `gridwatch/[nodeId]/beban` : Persentase beban (%)
- `gridwatch/[nodeId]/suhu` : Suhu operasional trafo (°C)
- `gridwatch/[nodeId]/daya` : Daya aktif (kW)

### 2. Topik Status & LWT (QoS 1, Retain: True)
Menjamin pengiriman minimal satu kali agar transisi status operasional terekam sistem.
- `gridwatch/[nodeId]/status` : Menyimpan state saat ini (`NORMAL`, `WARNING`, `FAULT`, `NO_POWER`, dll), role, dan info upstream.
- `gridwatch/[nodeId]/lwt` : Pesan *Last Will and Testament* (LWT) yang otomatis dipublikasikan broker dengan status `OFFLINE` jika program publisher mendadak mati / koneksi terputus.

### 3. Topik Command & Alarm (QoS 2, Retain: False)
Tingkat keandalan paling tinggi untuk pesan-pesan kritikal agar tidak ada perintah yang hilang atau dieksekusi ganda.
- `gridwatch/kontrol/[nodeId]/cmd` : Menerima perintah jarak jauh seperti `TRIP`, `RESET`, `ISOLATE`, `FAULT`.
- `gridwatch/kontrol/[nodeId]/ack` : Konfirmasi pengakuan (acknowledgment) bahwa trafo telah mengeksekusi perintah.
- `gridwatch/[nodeId]/alarm` : Publikasi pesan kritis / bahaya dari trafo ke *Alert Engine* atau *Dashboard*.

*(Catatan: `[nodeId]` diganti dengan ID masing-masing node seperti `gardu-induk`, `trafo-a`, `trafo-b`, `trafo-c`, `trafo-d`)*

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

3. **Konfigurasi Cloud (Opsional):** 
   Ubah file `.env` jika menggunakan MQTT Broker khusus (HiveMQ, dll) yang membutuhkan kredensial `MQTT_BROKER`, `MQTT_USERNAME`, dan `MQTT_PASSWORD`.

4. **Jalankan Aplikasi Utama:**
   Script di bawah akan menyalakan web server, subscriber, dan semua publisher node secara bersamaan:
   ```bash
   node run-all.js
   ```

5. **Akses Dashboard:**
   Buka web browser Anda di: `http://localhost:3000`

Di dashboard, Anda bisa melihat visualisasi cascade data secara langsung dan mencoba memutus daya (FAULT) pada node *upstream* (contoh: Trafo A) lalu mengamati bagaimana node *downstream* merespons secara otomatis (simulasi Auto-Recovery dan Mesh).
