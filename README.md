# Ammora Launchpad

Launchpad nyata untuk misi Builder [ammora.org](https://ammora.org/waitlist#mission):
buat token baru di bonding curve Ammora, trade di kurva, lalu graduate ke pool AMM.
Dibangun dengan **@ammora-protocol/sdk v0.3.9** di **GIWA Sepolia testnet (chain 91342)**.

> Perangkat lunak beta tanpa audit. Testnet saja — jangan gunakan dana asli.

## Yang dilakukan aplikasi ini

- **Connect wallet** (injected wallet, auto-switch ke GIWA Sepolia 91342)
- **Live Token**: daftar launch asli di GIWA Sepolia — dibaca dari Ammora Data API,
  dengan fallback scan event `LaunchCreated` on-chain dari factory
  (Data API sedang 503, jadi saat ini daftar berasal dari scan on-chain)
- **Buat Token Baru** — dua mode, keduanya satu transaksi dan di-preview dari state
  chain terbaru sebelum kamu menandatangani apa pun:
  - *Quick Create*: Config + token + kurva (`planTeamConfig` dari template #6 +
    `buildRegisterConfigAndCreateAmmoraV4Launch`, dikirim ke factory)
  - *Atomic Create + First Buy*: sama, ditambah first buy WETH di transaksi yang sama
    (`planTeamAtomicFromCatalog`; bila `APPROVAL_REQUIRED`, approve WETH dulu lalu
    re-plan di blok baru)
  - Token & curve dibaca dari receipt on-chain (`parseAmmoraV4LaunchCreatedReceipt`),
    bukan dari prediksi
- **Trade**: quote dulu via `planCurveAtBlock`, klasifikasi fill
  (`classifyAmmoraV4ExactInputFill`, ordinary fills harus `full`), eksekusi via
  `PreparedExactInputSwap` (approval + simulasi + verifikasi saldo ditangani di dalam)
- **Wrap ETH → WETH**, **Migrate** saat kurva `ReadyToMigrate`, **klaim fee** dari fee vault
- Semua transaksi menunggu **13 konfirmasi** (finality window GIWA yang direview SDK)

## Menjalankan lokal

```bash
npm install
npm run build     # output di dist/
npm run preview
```

## Deploy

Halaman live ini adalah hasil `npm run build` (`index.html` + `assets/` di root repo),
disajikan lewat GitHub Pages. Source lengkap (Vite + TypeScript) ada di repo yang sama.

## Alamat (GIWA Sepolia, dari katalog SDK — di-assert di `src/ammora.ts`)

- Factory: `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA`
- Config registry: `0x6d043014972b87406C4757a5f2d655A24e0b0aF9`
- First-buy executor: `0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451`
- Fee policy: `0x17B44C14F640fD429740FA3220f47a567c62725C`
- Graduation adapter: `0xF1A0f23036Aae88EEcecd1D9205Dd78c388fe263`
- WETH: `0x4200000000000000000000000000000000000006`
- Template: #6

## Misi

1. Build dengan SDK (aplikasi ini)
2. Post di X
3. Submit link website untuk review di https://ammora.org/waitlist#mission

Hadiah: bonus draw $tAMM + SBT setelah mainnet.
