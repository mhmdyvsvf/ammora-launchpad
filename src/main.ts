// Ammora Launchpad UI — every action below talks to GIWA Sepolia (91342)
// through @ammora-protocol/sdk 0.3.9. Nothing here is simulated.
import {
  FACTORY, REGISTRY, WETH,
  getPublicClient, getWalletClient, connectWallet, finalizedHead, verifyCore, getTemplate,
  listLaunches, getCurveQuote, previewQuickCreate, executeQuickCreate,
  previewAtomicCreate, executeAtomicCreate, getBalances,
  wrapEth, executeTrade, migrateCurve, getFeeClaimable, claimFees, getNextConfigId,
  explorerTx, explorerAddress, explorerToken,
  type LaunchSummary, type QuickCreatePreview, type AtomicPreview,
} from "./ammora.js";
import { formatUnits, parseUnits, type Address, type PublicClient, type WalletClient } from "viem";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $input = (id: string) => document.getElementById(id) as HTMLInputElement;
const shortAddr = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const fmt = (raw: bigint, decimals: number, digits = 4) => {
  const s = formatUnits(raw, decimals);
  const [i, f = ""] = s.split(".");
  return f ? `${i}.${f.slice(0, digits)}` : i;
};
const avatarBg = (a: string) => {
  const h = parseInt(a.slice(2, 6), 16) % 360;
  return `linear-gradient(135deg,hsl(${h} 70% 55%),hsl(${(h + 45) % 360} 70% 45%))`;
};

type Activity = { time: string; text: string; hash?: string };
const loadActivity = (): Activity[] => {
  try { return JSON.parse(localStorage.getItem("ammora-activity") ?? "[]") as Activity[]; } catch { return []; }
};
const saveActivity = (list: Activity[]) => localStorage.setItem("ammora-activity", JSON.stringify(list.slice(0, 30)));

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4500);
}
function logActivity(text: string, hash?: string) {
  const list = loadActivity();
  list.unshift({ time: new Date().toLocaleTimeString("id-ID"), text, hash });
  saveActivity(list);
  renderActivity();
}
function renderActivity() {
  const ul = $("txList");
  const list = loadActivity();
  ul.innerHTML = list.length
    ? list.map((a) => `<li><span>${a.time} — ${a.text}</span>${a.hash ? ` <a href="${explorerTx(a.hash)}" target="_blank" rel="noopener">${shortAddr(a.hash)}</a>` : ""}</li>`).join("")
    : `<li><span>Belum ada aktivitas on-chain dari launchpad ini.</span></li>`;
}

let client: PublicClient;
let wallet: WalletClient | null = null;
let account: Address | null = null;
let head = 0n;
let templateDecimals = 9;
let launches: LaunchSummary[] = [];
let selected: LaunchSummary | null = null;
let tradeSide: "buy" | "sell" = "buy";
let filter: "all" | "live" | "migrate" | "graduated" = "all";
let query = "";
let balances = { eth: 0n, weth: 0n, tokenBalance: 0n };

function statusLabel(s: number) {
  return s === 0 ? "Belum aktif" : s === 1 ? "Di kurva" : s === 2 ? "Siap migrate" : s === 3 ? "Graduated" : `Status ${s}`;
}

function curveSvg(progress: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const x = (i / 20) * 520;
    const y = 100 - (Math.pow(i / 20, 2) * 88 + 6);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const mx = Math.min(1, Math.max(0, progress)) * 520;
  const my = 100 - (Math.pow(Math.min(1, Math.max(0, progress)), 2) * 88 + 6);
  return `<polyline points="${pts.join(" ")}" fill="none" stroke="url(#g)" stroke-width="3" stroke-linejoin="round"/><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6d5cff"/><stop offset="1" stop-color="#14b8a6"/></linearGradient></defs><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="6" fill="#0d9488" stroke="#fff" stroke-width="2"/>`;
}

async function refreshHead() {
  head = await finalizedHead(client);
}

async function init() {
  renderActivity();
  client = getPublicClient();
  $("statTokens").textContent = "...";
  try {
    await refreshHead();
    await verifyCore(client, head);
    const template = await getTemplate(client, head);
    templateDecimals = Number(template.config.tokenDecimals ?? 9);
    const nextId = await getNextConfigId(client, head);
    $("statTemplate").textContent = template.enabled ? `Template #6 aktif • ${nextId - 1n} Config terdaftar` : "Template #6 nonaktif";
    $("statTokens").textContent = "memuat...";
    const found = await listLaunches(client, head, (done, total) => {
      $("statTokens").textContent = `memuat ${done}/${total}...`;
    });
    launches = found;
    $("statTokens").textContent = String(found.length);
    const raised = found.reduce((a, l) => a + l.quoteReserve, 0n);
    $("statRaised").textContent = `${fmt(raised, 18, 4)} WETH`;
    renderTokens();
    if (found.length) selectLaunch(found[0]!);
    toast("Terhubung ke GIWA Sepolia. Daftar launch dibaca langsung dari chain.");
  } catch (e) {
    console.error(e);
    toast(`Gagal membaca chain: ${(e as Error).message.slice(0, 120)}`);
    $("statTokens").textContent = "gagal";
  }
}

function renderTokens() {
  const grid = $("tokenGrid");
  const list = launches.filter((l) => {
    const statusOk = filter === "all" ? true
      : filter === "live" ? l.status === 1
      : filter === "migrate" ? l.status === 2
      : l.status === 3;
    const queryOk = query === "" || `${l.name} ${l.symbol} ${l.token} ${l.curve}`.toLowerCase().includes(query);
    return statusOk && queryOk;
  });
  if (!list.length) {
    grid.innerHTML = `<div class="card" style="grid-column:1/-1"><p class="sub">Tidak ada token pada filter ini. Coba filter lain, atau buat token pertamamu di atas.</p></div>`;
    return;
  }
  grid.innerHTML = list.map((l) => {
    const progress = l.migrationQuoteThreshold > 0n ? Number((l.quoteReserve * 10000n) / l.migrationQuoteThreshold) / 100 : 0;
    const pct = Math.min(100, progress);
    return `<article class="token ${selected?.curve === l.curve ? "selected" : ""}" data-curve="${l.curve}">
      <div class="token-head"><div class="token-top"><div class="avatar" style="background:${avatarBg(l.token)}">${escapeHtml((l.symbol || l.name || "?").charAt(0).toUpperCase())}</div><div><h3>${escapeHtml(l.name)}</h3><span class="sym">${escapeHtml(l.symbol)}</span></div></div><span class="pill">${statusLabel(l.status)}</span></div>
      <div class="kv"><span>Token</span><b class="mono"><a href="${explorerToken(l.token)}" target="_blank" rel="noopener">${shortAddr(l.token)}</a></b></div>
      <div class="kv"><span>Curve</span><b class="mono"><a href="${explorerAddress(l.curve)}" target="_blank" rel="noopener">${shortAddr(l.curve)}</a></b></div>
      <div class="kv"><span>Creator</span><b class="mono">${shortAddr(l.creator)}</b></div>
      <div class="kv"><span>Terkumpul</span><b>${fmt(l.quoteReserve, 18, 4)} / ${fmt(l.migrationQuoteThreshold, 18, 4)} WETH</b></div>
      <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="btn btn-teal" data-trade="${l.curve}" style="flex:1">Trade</button>
        <button class="btn btn-outline" data-detail="${l.curve}" style="flex:1">Detail</button>
      </div>
    </article>`;
  }).join("");
  grid.querySelectorAll("[data-trade]").forEach((b) =>
    b.addEventListener("click", () => {
      const l = launches.find((x) => x.curve === (b as HTMLElement).dataset.trade);
      if (l) selectLaunch(l);
      document.getElementById("trade")?.scrollIntoView({ behavior: "smooth" });
    }));
  grid.querySelectorAll("[data-detail]").forEach((b) =>
    b.addEventListener("click", () => {
      const l = launches.find((x) => x.curve === (b as HTMLElement).dataset.detail);
      if (l) selectLaunch(l);
    }));
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function selectLaunch(l: LaunchSummary) {
  selected = l;
  renderTokens();
  const progress = l.migrationQuoteThreshold > 0n ? Number((l.quoteReserve * 10000n) / l.migrationQuoteThreshold) / 100 : 0;
  $("tradeTitle").textContent = `Trade — ${l.name} (${l.symbol})`;
  $("tradeSub").textContent = `Status: ${statusLabel(l.status)} • Config #${l.configId} • Creator ${shortAddr(l.creator)}`;
  $("tradeSvg").innerHTML = curveSvg(Math.min(1, progress / 100));
  const price = l.baseReserve > 0n ? Number(l.quoteReserve) / 1e18 / (Number(l.baseReserve) / 10 ** l.decimals) : 0;
  $("tradePrice").textContent = price > 0 ? `~${price.toFixed(6)} WETH / token (dari cadangan)` : "—";
  $("tradeProgress").textContent = `${Math.min(100, progress).toFixed(1)}% menuju migrate`;
  $("tradeRaised").textContent = `${fmt(l.quoteReserve, 18, 4)} / ${fmt(l.migrationQuoteThreshold, 18, 4)} WETH`;
  $("tradeBar").style.width = `${Math.min(100, progress).toFixed(1)}%`;
  $("migrateBtn").style.display = l.status === 2 ? "" : "none";
  $("feeBox").style.display = l.feeVault && l.feeVault !== "0x0000000000000000000000000000000000000000" ? "" : "none";
  await refreshBalances();
  await refreshQuote();
}

async function refreshBalances() {
  if (!account) {
    $("tradeBalance").textContent = "Hubungkan wallet untuk melihat saldo.";
    return;
  }
  balances = await getBalances(client, account, selected?.token);
  $("tradeBalance").textContent =
    `${fmt(balances.eth, 18, 4)} ETH • ${fmt(balances.weth, 18, 4)} WETH` +
    (selected ? ` • ${fmt(balances.tokenBalance, selected.decimals, 2)} ${selected.symbol}` : "");
  if (selected && selected.feeVault !== "0x0000000000000000000000000000000000000000") {
    try {
      const claim = await getFeeClaimable(client, selected.feeVault, account, selected.token, head);
      $("feeInfo").textContent = `Fee yang bisa diklaim: ${fmt(claim.quote, 18, 6)} WETH + ${fmt(claim.base, selected.decimals, 2)} ${selected.symbol}`;
      ($("claimQuoteBtn") as HTMLButtonElement).disabled = claim.quote === 0n;
      ($("claimBaseBtn") as HTMLButtonElement).disabled = claim.base === 0n;
    } catch { $("feeInfo").textContent = "Fee belum bisa dibaca."; }
  }
}

async function refreshQuote() {
  if (!selected) return;
  const raw = $input("amount").value.trim();
  if (!raw || Number(raw) <= 0) { $("receiveEst").textContent = "—"; return; }
  try {
    await refreshHead();
    const decimals = tradeSide === "buy" ? 18 : selected.decimals;
    const amountIn = parseUnits(raw, decimals);
    const q = await getCurveQuote(client, selected.curve, head, amountIn, tradeSide === "sell", account);
    if (!q.quote || !q.fill) { $("receiveEst").textContent = "Kurva tidak aktif — tidak ada quote."; return; }
    const outDecimals = tradeSide === "buy" ? selected.decimals : 18;
    const outSym = tradeSide === "buy" ? selected.symbol : "WETH";
    const minOut = (q.quote.amountOut * 9900n) / 10000n;
    $("receiveEst").textContent = `~${fmt(q.quote.amountOut, outDecimals, 4)} ${outSym} (min ${fmt(minOut, outDecimals, 4)} • ${q.fill.kind})`;
  } catch (e) {
    $("receiveEst").textContent = `Quote gagal: ${(e as Error).message.slice(0, 90)}`;
  }
}

function buildMetadataURI(name: string, symbol: string, desc: string): string {
  const custom = ($input("tMeta").value ?? "").trim();
  if (custom) return custom;
  const json = JSON.stringify({ name, symbol, description: desc || `${name} — launched on Ammora (GIWA Sepolia testnet).`, image: "" });
  return `data:application/json,${encodeURIComponent(json)}`;
}

let quickPreview: QuickCreatePreview | null = null;
let atomicPreview: AtomicPreview | null = null;

async function onCreateSubmit(e: SubmitEvent) {
  e.preventDefault();
  if (!account || !wallet) { toast("Hubungkan wallet dulu."); return; }
  const name = ($input("tName").value ?? "").trim();
  const symbol = ($input("tSymbol").value ?? "").trim().toUpperCase();
  const desc = ($input("tDesc").value ?? "").trim();
  const supplyTokens = ($input("tSupply").value ?? "1000000").trim();
  const thresholdWeth = ($input("tThreshold").value ?? "0.001").trim();
  if (!name || !symbol) { toast("Isi nama dan simbol token."); return; }
  const mode = (document.querySelector('input[name="createMode"]:checked') as HTMLInputElement)?.value ?? "quick";
  const btn = $("createBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Menyiapkan preview on-chain...";
  try {
    await refreshHead();
    const saleSupplyRaw = parseUnits(supplyTokens, templateDecimals);
    const quoteThresholdRaw = parseUnits(thresholdWeth, 18);
    const metadataURI = buildMetadataURI(name, symbol, desc);
    if (mode === "quick") {
      quickPreview = await previewQuickCreate(client, account, head, { name, symbol, metadataURI, saleSupplyRaw, quoteThresholdRaw });
      $("createPreview").innerHTML = `
        <b>Preview Quick Create (template #6)</b><br>
        Factory <span class="mono">${shortAddr(FACTORY)}</span> • Registry <span class="mono">${shortAddr(REGISTRY)}</span><br>
        Owner: <span class="mono">${shortAddr(account)}</span> • Fee claimer (template): <span class="mono">${shortAddr(quickPreview.feeClaimer)}</span><br>
        Total supply: ${fmt(quickPreview.totalSupply, templateDecimals, 0)} ${symbol} • Biaya pembuatan (value): ${fmt(quickPreview.tx.value, 18, 6)} ETH + gas<br>
        <span class="hint">Satu transaksi: buat Config + token + kurva. Token dan curve dibaca dari receipt, bukan prediksi.</span>`;
      $("createBtn").textContent = "Konfirmasi & Buat Token (1 transaksi)";
      $("createBtn").dataset.armed = "quick";
    } else {
      const firstBuyWeth = ($input("firstBuy").value ?? "0.0001").trim();
      const quoteRaw = parseUnits(firstBuyWeth, 18);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      atomicPreview = await previewAtomicCreate(client, account, head, {
        saleSupplyRaw, quoteThresholdRaw, name, symbol, metadataURI,
        quoteRaw, minimumBaseRaw: 1n, maxFeePerGasWei: 0n, deadline,
      });
      const p = atomicPreview.plan;
      $("createPreview").innerHTML = `
        <b>Preview Atomic Create + First Buy</b> — status: <b>${p.status}</b><br>
        Config owner = Creator = pembeli: <span class="mono">${shortAddr(account)}</span><br>
        First buy: ${fmt(p.totalQuoteAmountRaw, 18, 6)} WETH${"predictedToken" in p && p.predictedToken ? ` • Prediksi token <span class="mono">${shortAddr(p.predictedToken)}</span>` : ""}<br>
        ${p.status === "APPROVAL_REQUIRED"
          ? `<span class="hint">Langkah 1: approve WETH ke first-buy executor. Setelah receipt, preview dihitung ulang di blok baru, baru eksekusi atomic.</span>`
          : `<span class="hint">READY: satu transaksi membuat Config + token + kurva + first buy.</span>`}`;
      $("createBtn").textContent = p.status === "APPROVAL_REQUIRED" ? "Approve WETH (langkah 1 dari 2)" : "Konfirmasi & Buat + First Buy";
      $("createBtn").dataset.armed = "atomic";
    }
    toast("Preview siap. Periksa angkanya, baru konfirmasi di wallet.");
  } catch (err) {
    console.error(err);
    toast(`Preview gagal: ${(err as Error).message.slice(0, 140)}`);
    $("createBtn").textContent = "Buat Token (on-chain)";
    delete $("createBtn").dataset.armed;
  } finally {
    btn.disabled = false;
  }
}

async function onCreateConfirm() {
  const armed = ($("createBtn").dataset.armed ?? "") as "" | "quick" | "atomic";
  if (!armed) { await onCreateSubmit(new SubmitEvent("submit")); return; }
  if (!account || !wallet) { toast("Hubungkan wallet dulu."); return; }
  const btn = $("createBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    if (armed === "quick" && quickPreview) {
      btn.textContent = "Menunggu signature di wallet...";
      const r = await executeQuickCreate(client, wallet, account, quickPreview);
      logActivity(`Quick Create: token ${shortAddr(r.token)} (Config #${r.configId})`, r.hash);
      toast(`Token dibuat! Config #${r.configId}.`);
      quickPreview = null;
      delete btn.dataset.armed;
      btn.textContent = "Buat Token (on-chain)";
      $("createPreview").innerHTML = `<b>Berhasil.</b> Token <a href="${explorerToken(r.token)}" target="_blank" rel="noopener">${shortAddr(r.token)}</a> • Curve <a href="${explorerAddress(r.curve)}" target="_blank" rel="noopener">${shortAddr(r.curve)}</a> • Tx <a href="${explorerTx(r.hash)}" target="_blank" rel="noopener">${shortAddr(r.hash)}</a>`;
      await reloadLaunches();
    } else if (armed === "atomic" && atomicPreview) {
      btn.textContent = "Menunggu signature di wallet...";
      const r = await executeAtomicCreate(client, wallet, account, atomicPreview);
      if (r.approvalConfirmed) {
        logActivity("Approve WETH untuk atomic first buy", r.hash);
        toast("Approval terkirim. Preview dihitung ulang di blok baru...");
        atomicPreview = null;
        delete btn.dataset.armed;
        btn.textContent = "Buat Token (on-chain)";
        await onCreateSubmit(new SubmitEvent("submit"));
        return;
      }
      logActivity(`Atomic create: token ${shortAddr(r.token!)} + first buy ${fmt(r.boughtBaseRaw!, templateDecimals, 2)} token`, r.hash);
      toast("Token + first buy berhasil!");
      atomicPreview = null;
      delete btn.dataset.armed;
      btn.textContent = "Buat Token (on-chain)";
      $("createPreview").innerHTML = `<b>Berhasil.</b> Token <a href="${explorerToken(r.token!)}" target="_blank" rel="noopener">${shortAddr(r.token!)}</a> • Curve <a href="${explorerAddress(r.curve!)}" target="_blank" rel="noopener">${shortAddr(r.curve!)}</a> • Tx <a href="${explorerTx(r.hash)}" target="_blank" rel="noopener">${shortAddr(r.hash)}</a>`;
      await reloadLaunches();
    }
  } catch (err) {
    console.error(err);
    toast(`Gagal: ${(err as Error).message.slice(0, 140)}`);
    btn.textContent = "Buat Token (on-chain)";
    delete btn.dataset.armed;
  } finally {
    btn.disabled = false;
  }
}

async function reloadLaunches() {
  await refreshHead();
  launches = await listLaunches(client, head);
  $("statTokens").textContent = String(launches.length);
  renderTokens();
}

async function onTrade() {
  if (!selected) { toast("Pilih token dulu."); return; }
  if (!account || !wallet) { toast("Hubungkan wallet dulu."); return; }
  const raw = $input("amount").value.trim();
  if (!raw || Number(raw) <= 0) { toast("Isi jumlah dulu."); return; }
  const btn = $("tradeBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Menyiapkan swap...";
  try {
    await refreshHead();
    const decimals = tradeSide === "buy" ? 18 : selected.decimals;
    const amountIn = parseUnits(raw, decimals);
    const tokenIn = tradeSide === "buy" ? WETH : selected.token;
    // Approval + simulasi + eksekusi ditangani PreparedExactInputSwap di dalam
    // executeTrade (persis contoh safe-swap resmi): jangan approve manual di sini.
    btn.textContent = "Menunggu signature swap...";
    const r = await executeTrade(client, wallet, account, selected.curve, tokenIn, amountIn, 100);
    const got = tradeSide === "buy" ? `${fmt(r.amountReceived, selected.decimals, 2)} ${selected.symbol}` : `${fmt(r.amountReceived, 18, 4)} WETH`;
    logActivity(`${tradeSide === "buy" ? "Beli" : "Jual"} ${selected.symbol}: terima ${got}`, r.hash);
    toast(`Swap berhasil, terima ${got}.`);
    await refreshBalances();
    await reloadLaunches();
    const fresh = launches.find((l) => l.curve === selected!.curve);
    if (fresh) await selectLaunch(fresh);
  } catch (err) {
    console.error(err);
    toast(`Swap gagal: ${(err as Error).message.slice(0, 140)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = tradeSide === "buy" ? "Beli Token" : "Jual Token";
  }
}

async function onWrap() {
  if (!account || !wallet) { toast("Hubungkan wallet dulu."); return; }
  const raw = ($input("wrapAmount").value ?? "").trim();
  if (!raw || Number(raw) <= 0) { toast("Isi jumlah ETH untuk di-wrap."); return; }
  const btn = $("wrapBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const wei = parseUnits(raw, 18);
    const r = await wrapEth(client, wallet, account, wei);
    logActivity(`Wrap ${raw} ETH menjadi WETH`, r.hash);
    toast("Wrap berhasil.");
    await refreshBalances();
  } catch (err) {
    toast(`Wrap gagal: ${(err as Error).message.slice(0, 120)}`);
  } finally { btn.disabled = false; }
}

async function onMigrate() {
  if (!selected || !account || !wallet) return;
  const btn = $("migrateBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Migrasi...";
  try {
    await refreshHead();
    const r = await migrateCurve(client, wallet, account, selected.curve, head);
    if (r.alreadyMigrated) { toast(`Sudah graduated. Pool: ${shortAddr(r.canonicalPool)}`); return; }
    logActivity(`Migrate ${selected.symbol} ke ARL pool ${shortAddr(r.canonicalPool)}`, r.hash!);
    toast(`Graduated! Pool AMM: ${shortAddr(r.canonicalPool)}`);
    await reloadLaunches();
    const fresh = launches.find((l) => l.curve === selected!.curve);
    if (fresh) await selectLaunch(fresh);
  } catch (err) {
    toast(`Migrate gagal: ${(err as Error).message.slice(0, 120)}`);
  } finally { btn.disabled = false; btn.textContent = "Migrate ke Pool AMM"; }
}

async function onClaim(kind: "quote" | "base") {
  if (!selected || !account || !wallet) return;
  try {
    const feeToken = kind === "quote" ? WETH : selected.token;
    const r = await claimFees(client, wallet, account, selected.feeVault, feeToken);
    logActivity(`Klaim fee ${kind === "quote" ? "WETH" : selected.symbol}`, r.hash);
    toast("Klaim fee terkirim.");
    await refreshBalances();
  } catch (err) {
    toast(`Klaim gagal: ${(err as Error).message.slice(0, 120)}`);
  }
}

function wire() {
  $("walletBtn").addEventListener("click", async () => {
    try {
      const btn = $("walletBtn") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Menghubungkan...";
      account = await connectWallet();
      wallet = getWalletClient(account);
      btn.textContent = `● ${shortAddr(account)}`;
      btn.disabled = false;
      ($("disconnectBtn") as HTMLButtonElement).style.display = "";
      toast(`Wallet terhubung: ${shortAddr(account)} (GIWA Sepolia)`);
      await refreshBalances();
    } catch (e) {
      toast(`Gagal menghubungkan wallet: ${(e as Error).message.slice(0, 120)}`);
      ($("walletBtn") as HTMLButtonElement).disabled = false;
      ($("walletBtn") as HTMLButtonElement).textContent = "Hubungkan Wallet";
    }
  });

  $("disconnectBtn").addEventListener("click", () => {
    account = null;
    wallet = null;
    balances = { eth: 0n, weth: 0n, tokenBalance: 0n };
    ($("walletBtn") as HTMLButtonElement).textContent = "Hubungkan Wallet";
    ($("disconnectBtn") as HTMLButtonElement).style.display = "none";
    void refreshBalances();
    toast("Wallet diputuskan dari halaman ini. Kalau di aplikasi wallet masih tertulis terhubung, putuskan juga dari menu situs terhubung di wallet.");
  });

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      filter = (t as HTMLElement).dataset.filter as typeof filter;
      renderTokens();
    }));

  $("tokenSearch").addEventListener("input", () => {
    query = ($input("tokenSearch").value ?? "").trim().toLowerCase();
    renderTokens();
  });

  $("createForm").addEventListener("submit", (e) => { e.preventDefault(); void onCreateSubmit(e as SubmitEvent); });
  $("createBtn").addEventListener("click", () => { void onCreateConfirm(); });
  document.querySelectorAll('input[name="createMode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const mode = (document.querySelector('input[name="createMode"]:checked') as HTMLInputElement)?.value;
      $("firstBuyRow").style.display = mode === "atomic" ? "" : "none";
      delete ($("createBtn") as HTMLButtonElement).dataset.armed;
      ($("createBtn") as HTMLButtonElement).textContent = "Buat Token (on-chain)";
      $("createPreview").innerHTML = "";
    }));

  $("buyTab").addEventListener("click", () => {
    tradeSide = "buy";
    $("buyTab").className = "active-buy";
    $("sellTab").className = "";
    $("amountLabel").textContent = "Jumlah WETH";
    $("tradeBtn").textContent = "Beli Token";
    void refreshQuote();
  });
  $("sellTab").addEventListener("click", () => {
    tradeSide = "sell";
    $("sellTab").className = "active-sell";
    $("buyTab").className = "";
    $("amountLabel").textContent = `Jumlah ${selected?.symbol ?? "token"}`;
    $("tradeBtn").textContent = "Jual Token";
    void refreshQuote();
  });
  $("amount").addEventListener("input", () => { void refreshQuote(); });
  document.querySelectorAll("[data-q]").forEach((b) =>
    b.addEventListener("click", () => {
      ($("amount") as HTMLInputElement).value = (b as HTMLElement).dataset.q!;
      void refreshQuote();
    }));
  $("tradeBtn").addEventListener("click", () => { void onTrade(); });
  $("wrapBtn").addEventListener("click", () => { void onWrap(); });
  $("migrateBtn").addEventListener("click", () => { void onMigrate(); });
  $("claimQuoteBtn").addEventListener("click", () => { void onClaim("quote"); });
  $("claimBaseBtn").addEventListener("click", () => { void onClaim("base"); });
}

wire();
void init();
