# GridWatch: Sistem Monitoring Distribusi Trafo Listrik

GridWatch adalah simulasi sistem monitoring real-time untuk jaringan distribusi trafo listrik. Proyek ini mendemonstrasikan implementasi protokol MQTT untuk memantau status operasional jaringan distribusi listrik dari gardu induk hingga trafo distribusi komersial dan residensial.

## Konsep Aplikasi

Pada jaringan kelistrikan nyata, energi dari Gardu Induk (tegangan tinggi) diturunkan ke Trafo Feeder, lalu didistribusikan ke Trafo Distribusi sebelum sampai ke konsumen akhir. Topologi jaringan ini membentuk hierarki (tree/chain). Masalah umum yang terjadi adalah ketika satu titik di tengah rantai mengalami gangguan (fault), seluruh node di bawahnya (downstream) akan kehilangan pasokan listrik. Tanpa sistem monitoring yang memadai, sulit untuk menemukan titik masalah utama.

GridWatch menyimulasikan sistem monitoring tersebut dengan memanfaatkan **protokol MQTT**. Setiap trafo dipresentasikan sebagai *node* yang saling terhubung sesuai dengan topologinya. 

Fitur utama aplikasi ini:
1. **Cascade Fault Simulation**: Jika satu node di hulu (upstream) mengalami gangguan atau pemutusan daya, node di hilirnya (downstream) akan secara otomatis mendeteksi ketiadaan daya dan ikut melaporkan status ketiadaan pasokan.
2. **Real-Time Monitoring Dashboard**: Antarmuka web yang menampilkan peta distribusi, status kesehatan node (tegangan, arus, suhu, dan beban), log aktivitas, serta grafik historis secara real-time.
3. **Command Control Center**: Kemampuan untuk mengontrol status setiap trafo secara jarak jauh. Operator dapat memutus (TRIP), memulihkan (RESET), atau menyimulasikan gangguan (FAULT) pada setiap titik.

## Topologi Jaringan

Simulasi ini menggunakan topologi jaringan di wilayah Surabaya dengan empat node utama:

- **Gardu Induk (Surabaya Pusat)**: Titik sumber listrik (150kV ke 20kV). Tidak bergantung pada pasokan node lain.
- **Trafo A (Gubeng)**: Feeder residensial (20kV ke 380V). Bergantung pada Gardu Induk.
- **Trafo B (Rungkut)**: Distribusi kawasan industri (20kV ke 380V, 3-phase). Bergantung pada Trafo A.
- **Trafo C (Tunjungan)**: Distribusi kawasan komersial (20kV ke 220V). Bergantung pada Trafo B.

Alur ketergantungan daya: `Gardu Induk -> Trafo A -> Trafo B -> Trafo C`

## Implementasi Fitur MQTT

Aplikasi ini menggunakan berbagai fitur standar MQTT untuk menjamin keandalan pengiriman data:

- **Quality of Service (QoS)**:
  - **QoS 0**: Digunakan untuk pengiriman data sensor (tegangan, arus, suhu, beban) karena bersifat periodik dan hilangnya sebagian data tidak memengaruhi sistem secara keseluruhan.
  - **QoS 1**: Digunakan untuk pembaruan status operasional setiap trafo. Menjamin pesan setidaknya sampai satu kali.
  - **QoS 2**: Digunakan untuk pengiriman perintah (command) dari dashboard dan sistem alarm kritis untuk memastikan tidak ada perintah yang hilang atau terduplikasi.
- **Retained Messages**: Pesan sensor dan status terakhir dikirimkan dengan flag *retain*. Hal ini memungkinkan subscriber yang baru terhubung (seperti membuka dashboard) untuk langsung mendapatkan kondisi terakhir tanpa menunggu publikasi siklus berikutnya.
- **Last Will and Testament (LWT)**: Setiap publisher mendaftarkan pesan LWT ke broker. Jika program trafo crash atau kehilangan koneksi, broker akan otomatis menyebarkan pesan "OFFLINE" untuk node tersebut.
- **Topic Wildcards**: 
  - `gridwatch/+/status`: Digunakan oleh sistem alert untuk memantau status semua trafo sekaligus tanpa harus mendaftarkan topiknya satu per satu.
  - `gridwatch/#`: Digunakan oleh dashboard untuk menangkap seluruh lalu lintas data terkait GridWatch.
- **Persistent Session**: Sistem alert terhubung menggunakan pengaturan `clean: false`, sehingga jika koneksi jaringan terputus sementara, broker akan menyimpan pesan alarm dan mengirimkannya saat sistem alert online kembali.

## Arsitektur Sistem

Proyek ini terdiri dari beberapa komponen yang bekerja bersama:

1. **Broker MQTT**: Layanan pusat yang mengatur lalu lintas pesan (memanfaatkan broker publik `broker.emqx.io`).
2. **Publishers**: Terdapat skrip terpisah untuk setiap titik (Gardu Induk, Trafo A, Trafo B, Trafo C) yang secara rutin memublikasikan data kondisinya dan mendengarkan status dari node di atasnya.
3. **Alert Engine (Subscriber)**: Layanan latar belakang yang memantau aliran data, bertugas mendeteksi perubahan status dan anomali, serta menentukan sumber utama jika terjadi insiden listrik padam secara berantai.
4. **Dashboard Subscriber**: Jembatan perantara antara protokol MQTT dengan protokol WebSocket. Komponen ini menerjemahkan pesan MQTT agar bisa disalurkan secara langsung ke antarmuka web.
5. **Dashboard Server**: Berperan menyajikan antarmuka visual (HTML/CSS/JS) melalui peramban web kepada operator sistem.

## Cara Menjalankan Aplikasi

1. **Persiapan Folder:** Pastikan Anda berada di direktori `gridwatch` di dalam terminal.
   ```bash
   cd gridwatch
   ```

2. **Instalasi Dependensi:** Unduh semua *library* pendukung (seperti `mqtt`, `express`, `ws`) menggunakan npm.
   ```bash
   npm install
   ```

3. **Konfigurasi Cloud (Opsional):** Jika Anda ingin menggunakan MQTT Cloud pribadi Anda yang memiliki otentikasi (username/password), silakan ubah pengaturan di file `.env`. Secara bawaan (*default*), aplikasi menggunakan broker publik `broker.emqx.io` tanpa password.

4. **Jalankan Semua Layanan:** Jalankan *script* utama yang akan secara otomatis menyalakan Web Server, Alert Engine, Dashboard Subscriber, dan keempat Publisher Node.
   ```bash
   node run-all.js
   ```

5. **Akses Dashboard:** Buka web browser Anda dan akses halaman simulasi di:
   `http://localhost:3000`

Melalui dashboard, Anda dapat memantau visualisasi topologi secara *real-time* dan menggunakan panel "KONTROL" di sisi kanan untuk menguji sistem simulasi pemadaman (*Cascade Fault*) dan pemulihan otomatis (*Auto-Recovery*) pada cabang residensial.
