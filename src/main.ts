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
    : `<li><span>No activity in this browser yet. Creates, buys, and sells from this page will appear here.</span></li>`;
}

// Saved launch list (localStorage): repeat visits render instantly from the
// last good read while fresh chain data loads behind it. Bigints are stored
// as decimal strings and converted back on load. Best-effort: a corrupt or
// unavailable store just means no cache, never a broken page.
const CACHE_KEY = "ammora-launches-cache";
const CACHE_BIGINT_FIELDS = ["configId", "sqrtPrice", "baseReserve", "quoteReserve", "migrationQuoteThreshold", "migrationBaseThreshold"] as const;
function loadCachedLaunches(): { savedAt: number; launches: LaunchSummary[] } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; launches: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.launches) || !parsed.launches.length) return null;
    const launches = parsed.launches.map((o) => {
      const out = { ...o } as Record<string, unknown>;
      for (const f of CACHE_BIGINT_FIELDS) out[f] = BigInt(String(o[f] ?? "0"));
      return out as unknown as LaunchSummary;
    });
    return { savedAt: parsed.savedAt, launches };
  } catch { return null; }
}
function saveCachedLaunches(list: LaunchSummary[]) {
  try {
    const launches = list.map((l) => {
      const out = { ...l } as Record<string, unknown>;
      for (const f of CACHE_BIGINT_FIELDS) out[f] = (l[f] as bigint).toString();
      return out;
    });
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), launches }));
  } catch { /* storage full or blocked — cache is optional */ }
}

let client: PublicClient;
let wallet: WalletClient | null = null;
let account: Address | null = null;
let head = 0n;
let templateDecimals = 9;
let launches: LaunchSummary[] = [];
let selected: LaunchSummary | null = null;
let topToken: LaunchSummary | null = null;
let tradeSide: "buy" | "sell" = "buy";
let filter: "all" | "live" | "migrate" | "graduated" = "all";
let query = "";
let balances = { eth: 0n, weth: 0n, tokenBalance: 0n };

function statusLabel(s: number) {
  return s === 0 ? "Not live" : s === 1 ? "On curve" : s === 2 ? "Ready to migrate" : s === 3 ? "Graduated" : `Status ${s}`;
}

function statusPillClass(s: number) {
  return s === 1 ? "st-live" : s === 2 ? "st-migrate" : s === 3 ? "st-grad" : "st-notlive";
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
  const area = `M0,100 L${pts.join(" L")} L520,100 Z`;
  const grid = [25, 50, 75].map((y) => `<line x1="0" y1="${y}" x2="520" y2="${y}" style="stroke:var(--line)" stroke-width="1"/>`).join("");
  return `${grid}<path d="${area}" fill="url(#gf)"/><polyline points="${pts.join(" ")}" fill="none" stroke="url(#g)" stroke-width="3" stroke-linejoin="round"/><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6d5cff"/><stop offset="1" stop-color="#14b8a6"/></linearGradient><linearGradient id="gf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d5cff" stop-opacity="0.28"/><stop offset="1" stop-color="#14b8a6" stop-opacity="0.02"/></linearGradient></defs><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="6" fill="#0d9488" stroke="#fff" stroke-width="2"/>`;
}

// Small bonding-curve sparkline drawn on every token card.
function miniCurveSvg(progress: number, gid: string): string {
  const pts: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const x = (i / 20) * 200;
    const y = 36 - (Math.pow(i / 20, 2) * 30 + 3);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const p = Math.min(1, Math.max(0, progress));
  const mx = p * 200;
  const my = 36 - (Math.pow(p, 2) * 30 + 3);
  return `<svg class="mini-curve" viewBox="0 0 200 40" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6d5cff"/><stop offset="1" stop-color="#14b8a6"/></linearGradient></defs><polyline points="${pts.join(" ")}" fill="none" stroke="url(#${gid})" stroke-width="2.5" stroke-linejoin="round"/><circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="3.5" fill="#0d9488" stroke="#fff" stroke-width="1.5"/></svg>`;
}

// Placeholder curve shown in the Trade panel before any token is picked:
// a faint dashed curve plus a label, so the panel never looks like a
// blank white box. The old hardcoded #f8fafc background did not adapt to
// dark mode and rendered as a big empty white rectangle.
function placeholderCurveSvg(): string {
  const pts: string[] = [];
  for (let i = 0; i <= 20; i++) {
    const x = (i / 20) * 520;
    const y = 100 - (Math.pow(i / 20, 2) * 88 + 6);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `<polyline points="${pts.join(" ")}" fill="none" stroke="#64748b" stroke-width="3" stroke-linejoin="round" stroke-dasharray="1 7" stroke-linecap="round" opacity="0.55"/><text x="260" y="56" text-anchor="middle" fill="#94a3b8" font-size="14" font-weight="600">Pick a token above to see its bonding curve</text>`;
}

// Hero spotlight: the highest-raised live token, updated as launches stream in.
function updateSpot() {
  const top = launches[0] ?? null;
  topToken = top;
  if (!top) return;
  $("spotName").textContent = `${top.name} (${top.symbol})`;
  $("spotMeta").textContent = `Raised ${fmt(top.quoteReserve, 18, 4)} WETH • ${statusLabel(top.status)}`;
  ($("spotTrade") as HTMLButtonElement).style.display = "";
}

async function refreshHead() {
  head = await finalizedHead(client);
  $("headBlock").textContent = String(head);
}

async function init() {
  renderActivity();
  client = getPublicClient();
  $("tradeSvg").innerHTML = placeholderCurveSvg();
  $("statTokens").textContent = "loading…";
  $("statRaised").textContent = "loading…";
  const statusEl = $("tokenLoadStatus");
  // Instant repeat visits: show the saved list right away (if any) while
  // fresh chain data loads behind it. First visit has no cache — the
  // skeleton cards in the HTML show instead.
  const cached = loadCachedLaunches();
  if (cached) {
    launches = cached.launches;
    launches.sort((a, b) => Number(b.quoteReserve - a.quoteReserve));
    $("statTokens").textContent = String(launches.length);
    const raised = launches.reduce((a, x) => a + x.quoteReserve, 0n);
    $("statRaised").textContent = `${fmt(raised, 18, 4)} WETH`;
    const when = new Date(cached.savedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    statusEl.textContent = `Showing saved list from ${when} • updating from the chain…`;
    renderTokens();
    updateSpot();
  }
  try {
    await refreshHead();
    await verifyCore(client, head);
    const template = await getTemplate(client, head);
    templateDecimals = Number(template.config.tokenDecimals ?? 9);
    const nextId = await getNextConfigId(client, head);
    $("statTemplate").textContent = template.enabled ? `Template #6 active • ${nextId - 1n} configs registered` : "Template #6 inactive";
    // Incremental render: each token appears in the grid as soon as its
    // on-chain data is read, with a running raised total — the page is
    // never a blank list for the whole ~2 min load. Upsert: fresh rows
    // replace the cached rows for the same curve.
    const onLaunch = (l: LaunchSummary) => {
      const idx = launches.findIndex((x) => x.curve === l.curve);
      if (idx >= 0) launches[idx] = l;
      else launches.push(l);
      launches.sort((a, b) => Number(b.quoteReserve - a.quoteReserve));
      $("statTokens").textContent = String(launches.length);
      const raised = launches.reduce((a, x) => a + x.quoteReserve, 0n);
      $("statRaised").textContent = `${fmt(raised, 18, 4)} WETH`;
      renderTokens();
      updateSpot();
    };
    const found = await listLaunches(client, head, (done, total, phase) => {
      if (phase === "scan") {
        statusEl.textContent = `Scanning the chain for launches… ${done} found so far`;
        $("statTokens").textContent = "loading…";
      } else {
        statusEl.textContent = `Reading token details… ${done}/${total}`;
        $("statTokens").textContent = String(done);
      }
    }, onLaunch);
    if (!launches.length) launches = found;
    $("statTokens").textContent = String(found.length);
    const raised = found.reduce((a, l) => a + l.quoteReserve, 0n);
    $("statRaised").textContent = `${fmt(raised, 18, 4)} WETH`;
    statusEl.textContent = found.length
      ? `${found.length} live tokens • read from the chain, highest raised first`
      : "No launches found on-chain yet. Create the first token above.";
    renderTokens();
    updateSpot();
    saveCachedLaunches(launches);
    if (found.length) selectLaunch(found[0]!);
    toast("Connected to GIWA Sepolia. Launch list read straight from the chain.");
  } catch (e) {
    console.error(e);
    toast(`Failed to read the chain: ${(e as Error).message.slice(0, 120)}`);
    $("statTokens").textContent = "failed";
    statusEl.textContent = launches.length
      ? "Could not refresh from the chain — showing the saved list."
      : "Could not read the launch list. Check your connection and refresh the page.";
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
    grid.innerHTML = `<div class="card" style="grid-column:1/-1"><p class="sub">No tokens match this filter. Try another filter, or create your first token above.</p></div>`;
    return;
  }
  grid.innerHTML = list.map((l) => {
    const progress = l.migrationQuoteThreshold > 0n ? Number((l.quoteReserve * 10000n) / l.migrationQuoteThreshold) / 100 : 0;
    const pct = Math.min(100, progress);
    return `<article class="token ${selected?.curve === l.curve ? "selected" : ""}" data-curve="${l.curve}">
      <div class="token-head"><div class="token-top"><div class="avatar" style="background:${avatarBg(l.token)}">${escapeHtml((l.symbol || l.name || "?").charAt(0).toUpperCase())}</div><div><h3>${escapeHtml(l.name)}</h3><span class="sym">${escapeHtml(l.symbol)}</span></div></div><span class="pill ${statusPillClass(l.status)}">${statusLabel(l.status)}</span></div>
      <div class="kv"><span>Token</span><b class="mono"><a href="${explorerToken(l.token)}" target="_blank" rel="noopener">${shortAddr(l.token)}</a></b></div>
      <div class="kv"><span>Curve</span><b class="mono"><a href="${explorerAddress(l.curve)}" target="_blank" rel="noopener">${shortAddr(l.curve)}</a></b></div>
      <div class="kv"><span>Creator</span><b class="mono">${shortAddr(l.creator)}</b></div>
      <div class="kv"><span>Raised</span><b>${fmt(l.quoteReserve, 18, 4)} / ${fmt(l.migrationQuoteThreshold, 18, 4)} WETH</b></div>
      <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
      ${miniCurveSvg(pct / 100, `mg${l.curve.slice(2, 8)}`)}
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
  $("tradePrice").textContent = price > 0 ? `~${price.toFixed(6)} WETH / token (from reserves)` : "—";
  $("tradeProgress").textContent = `${Math.min(100, progress).toFixed(1)}% to migrate`;
  $("tradeRaised").textContent = `${fmt(l.quoteReserve, 18, 4)} / ${fmt(l.migrationQuoteThreshold, 18, 4)} WETH`;
  $("tradeBar").style.width = `${Math.min(100, progress).toFixed(1)}%`;
  $("migrateBtn").style.display = l.status === 2 ? "" : "none";
  $("feeBox").style.display = l.feeVault && l.feeVault !== "0x0000000000000000000000000000000000000000" ? "" : "none";
  await refreshBalances();
  await refreshQuote();
}

async function refreshBalances() {
  if (!account) {
    $("tradeBalance").textContent = "Connect your wallet to see your balance.";
    return;
  }
  balances = await getBalances(client, account, selected?.token);
  $("tradeBalance").textContent =
    `${fmt(balances.eth, 18, 4)} ETH • ${fmt(balances.weth, 18, 4)} WETH` +
    (selected ? ` • ${fmt(balances.tokenBalance, selected.decimals, 2)} ${selected.symbol}` : "");
  if (selected && selected.feeVault !== "0x0000000000000000000000000000000000000000") {
    try {
      const claim = await getFeeClaimable(client, selected.feeVault, account, selected.token, head);
      $("feeInfo").textContent = `Claimable fees: ${fmt(claim.quote, 18, 6)} WETH + ${fmt(claim.base, selected.decimals, 2)} ${selected.symbol}`;
      ($("claimQuoteBtn") as HTMLButtonElement).disabled = claim.quote === 0n;
      ($("claimBaseBtn") as HTMLButtonElement).disabled = claim.base === 0n;
    } catch { $("feeInfo").textContent = "Fees could not be read yet."; }
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
    if (!q.quote || !q.fill) { $("receiveEst").textContent = "Curve is not live — no quote available."; return; }
    const outDecimals = tradeSide === "buy" ? selected.decimals : 18;
    const outSym = tradeSide === "buy" ? selected.symbol : "WETH";
    const minOut = (q.quote.amountOut * 9900n) / 10000n;
    $("receiveEst").textContent = `~${fmt(q.quote.amountOut, outDecimals, 4)} ${outSym} (min ${fmt(minOut, outDecimals, 4)} • ${q.fill.kind})`;
  } catch (e) {
    $("receiveEst").textContent = `Quote failed: ${(e as Error).message.slice(0, 90)}`;
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
  if (!account || !wallet) { toast("Connect your wallet first."); return; }
  const name = ($input("tName").value ?? "").trim();
  const symbol = ($input("tSymbol").value ?? "").trim().toUpperCase();
  const desc = ($input("tDesc").value ?? "").trim();
  const supplyTokens = ($input("tSupply").value ?? "1000000").trim();
  const thresholdWeth = ($input("tThreshold").value ?? "0.001").trim();
  if (!name || !symbol) { toast("Enter a token name and symbol."); return; }
  const mode = (document.querySelector('input[name="createMode"]:checked') as HTMLInputElement)?.value ?? "quick";
  const btn = $("createBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Preparing on-chain preview...";
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
        Total supply: ${fmt(quickPreview.totalSupply, templateDecimals, 0)} ${symbol} • Creation cost (value): ${fmt(quickPreview.tx.value, 18, 6)} ETH + gas<br>
        <span class="hint">One transaction: create the Config + token + curve. Token and curve are read from the receipt, not predicted.</span>`;
      $("createBtn").textContent = "Confirm & Create Token (1 transaction)";
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
        Config owner = Creator = buyer: <span class="mono">${shortAddr(account)}</span><br>
        First buy: ${fmt(p.totalQuoteAmountRaw, 18, 6)} WETH${"predictedToken" in p && p.predictedToken ? ` • Predicted token <span class="mono">${shortAddr(p.predictedToken)}</span>` : ""}<br>
        ${p.status === "APPROVAL_REQUIRED"
          ? `<span class="hint">Step 1: approve WETH to the first-buy executor. After the receipt, the preview is re-priced at a fresh block, then the atomic execution runs.</span>`
          : `<span class="hint">READY: one transaction creates the Config + token + curve + first buy.</span>`}`;
      $("createBtn").textContent = p.status === "APPROVAL_REQUIRED" ? "Approve WETH (step 1 of 2)" : "Confirm & Create + First Buy";
      $("createBtn").dataset.armed = "atomic";
    }
    toast("Preview ready. Check the numbers, then confirm in your wallet.");
  } catch (err) {
    console.error(err);
    toast(`Preview failed: ${(err as Error).message.slice(0, 140)}`);
    $("createBtn").textContent = "Create Token (on-chain)";
    delete $("createBtn").dataset.armed;
  } finally {
    btn.disabled = false;
  }
}

async function onCreateConfirm() {
  const armed = ($("createBtn").dataset.armed ?? "") as "" | "quick" | "atomic";
  if (!armed) { await onCreateSubmit(new SubmitEvent("submit")); return; }
  if (!account || !wallet) { toast("Connect your wallet first."); return; }
  const btn = $("createBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    if (armed === "quick" && quickPreview) {
      btn.textContent = "Waiting for your signature in the wallet...";
      const r = await executeQuickCreate(client, wallet, account, quickPreview);
      logActivity(`Quick Create: token ${shortAddr(r.token)} (Config #${r.configId})`, r.hash);
      toast(`Token created! Config #${r.configId}.`);
      quickPreview = null;
      delete btn.dataset.armed;
      btn.textContent = "Create Token (on-chain)";
      $("createPreview").innerHTML = `<b>Success.</b> Token <a href="${explorerToken(r.token)}" target="_blank" rel="noopener">${shortAddr(r.token)}</a> • Curve <a href="${explorerAddress(r.curve)}" target="_blank" rel="noopener">${shortAddr(r.curve)}</a> • Tx <a href="${explorerTx(r.hash)}" target="_blank" rel="noopener">${shortAddr(r.hash)}</a>`;
      await reloadLaunches();
    } else if (armed === "atomic" && atomicPreview) {
      btn.textContent = "Waiting for your signature in the wallet...";
      const r = await executeAtomicCreate(client, wallet, account, atomicPreview);
      if (r.approvalConfirmed) {
        logActivity("Approve WETH for atomic first buy", r.hash);
        toast("Approval sent. Preview will be re-priced at a fresh block...");
        atomicPreview = null;
        delete btn.dataset.armed;
        btn.textContent = "Create Token (on-chain)";
        await onCreateSubmit(new SubmitEvent("submit"));
        return;
      }
      logActivity(`Atomic create: token ${shortAddr(r.token!)} + first buy ${fmt(r.boughtBaseRaw!, templateDecimals, 2)} tokens`, r.hash);
      toast("Token + first buy created!");
      atomicPreview = null;
      delete btn.dataset.armed;
      btn.textContent = "Create Token (on-chain)";
      $("createPreview").innerHTML = `<b>Success.</b> Token <a href="${explorerToken(r.token!)}" target="_blank" rel="noopener">${shortAddr(r.token!)}</a> • Curve <a href="${explorerAddress(r.curve!)}" target="_blank" rel="noopener">${shortAddr(r.curve!)}</a> • Tx <a href="${explorerTx(r.hash)}" target="_blank" rel="noopener">${shortAddr(r.hash)}</a>`;
      await reloadLaunches();
    }
  } catch (err) {
    console.error(err);
    toast(`Failed: ${(err as Error).message.slice(0, 140)}`);
    btn.textContent = "Create Token (on-chain)";
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
  updateSpot();
  saveCachedLaunches(launches);
}

async function onTrade() {
  if (!selected) { toast("Pick a token first."); return; }
  if (!account || !wallet) { toast("Connect your wallet first."); return; }
  const raw = $input("amount").value.trim();
  if (!raw || Number(raw) <= 0) { toast("Enter an amount first."); return; }
  const btn = $("tradeBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Preparing swap...";
  try {
    await refreshHead();
    const decimals = tradeSide === "buy" ? 18 : selected.decimals;
    const amountIn = parseUnits(raw, decimals);
    const tokenIn = tradeSide === "buy" ? WETH : selected.token;
    // Approval + simulasi + eksekusi ditangani PreparedExactInputSwap di dalam
    // executeTrade (persis contoh safe-swap resmi): jangan approve manual di sini.
    btn.textContent = "Waiting for the swap signature...";
    const r = await executeTrade(client, wallet, account, selected.curve, tokenIn, amountIn, 100);
    const got = tradeSide === "buy" ? `${fmt(r.amountReceived, selected.decimals, 2)} ${selected.symbol}` : `${fmt(r.amountReceived, 18, 4)} WETH`;
    logActivity(`${tradeSide === "buy" ? "Buy" : "Sell"} ${selected.symbol}: received ${got}`, r.hash);
    toast(`Swap successful, received ${got}.`);
    await refreshBalances();
    await reloadLaunches();
    const fresh = launches.find((l) => l.curve === selected!.curve);
    if (fresh) await selectLaunch(fresh);
  } catch (err) {
    console.error(err);
    toast(`Swap failed: ${(err as Error).message.slice(0, 140)}`);
  } finally {
    btn.disabled = false;
    btn.textContent = tradeSide === "buy" ? "Buy Token" : "Sell Token";
  }
}

async function onWrap() {
  if (!account || !wallet) { toast("Connect your wallet first."); return; }
  const raw = ($input("wrapAmount").value ?? "").trim();
  if (!raw || Number(raw) <= 0) { toast("Enter the amount of ETH to wrap."); return; }
  const btn = $("wrapBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const wei = parseUnits(raw, 18);
    const r = await wrapEth(client, wallet, account, wei);
    logActivity(`Wrap ${raw} ETH into WETH`, r.hash);
    toast("Wrap successful.");
    await refreshBalances();
  } catch (err) {
    toast(`Wrap failed: ${(err as Error).message.slice(0, 120)}`);
  } finally { btn.disabled = false; }
}

async function onMigrate() {
  if (!selected || !account || !wallet) return;
  const btn = $("migrateBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Migrating...";
  try {
    await refreshHead();
    const r = await migrateCurve(client, wallet, account, selected.curve, head);
    if (r.alreadyMigrated) { toast(`Already graduated. Pool: ${shortAddr(r.canonicalPool)}`); return; }
    logActivity(`Migrate ${selected.symbol} to ARL pool ${shortAddr(r.canonicalPool)}`, r.hash!);
    toast(`Graduated! AMM pool: ${shortAddr(r.canonicalPool)}`);
    await reloadLaunches();
    const fresh = launches.find((l) => l.curve === selected!.curve);
    if (fresh) await selectLaunch(fresh);
  } catch (err) {
    toast(`Migrate failed: ${(err as Error).message.slice(0, 120)}`);
  } finally { btn.disabled = false; btn.textContent = "Migrate to AMM Pool"; }
}

async function onClaim(kind: "quote" | "base") {
  if (!selected || !account || !wallet) return;
  try {
    const feeToken = kind === "quote" ? WETH : selected.token;
    const r = await claimFees(client, wallet, account, selected.feeVault, feeToken);
    logActivity(`Claim ${kind === "quote" ? "WETH" : selected.symbol}`, r.hash);
    toast("Fee claim sent.");
    await refreshBalances();
  } catch (err) {
    toast(`Claim failed: ${(err as Error).message.slice(0, 120)}`);
  }
}

function wire() {
  $("walletBtn").addEventListener("click", async () => {
    try {
      const btn = $("walletBtn") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Connecting...";
      account = await connectWallet();
      wallet = getWalletClient(account);
      btn.textContent = `● ${shortAddr(account)}`;
      btn.disabled = false;
      ($("disconnectBtn") as HTMLButtonElement).style.display = "";
      toast(`Wallet connected: ${shortAddr(account)} (GIWA Sepolia)`);
      await refreshBalances();
    } catch (e) {
      toast(`Failed to connect wallet: ${(e as Error).message.slice(0, 120)}`);
      ($("walletBtn") as HTMLButtonElement).disabled = false;
      ($("walletBtn") as HTMLButtonElement).textContent = "Connect Wallet";
    }
  });

  $("disconnectBtn").addEventListener("click", () => {
    account = null;
    wallet = null;
    balances = { eth: 0n, weth: 0n, tokenBalance: 0n };
    ($("walletBtn") as HTMLButtonElement).textContent = "Connect Wallet";
    ($("disconnectBtn") as HTMLButtonElement).style.display = "none";
    void refreshBalances();
    toast("Wallet disconnected from this page. If your wallet app still lists it as connected, disconnect it there too, from the wallet's connected-sites menu.");
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

  $("spotTrade").addEventListener("click", () => {
    if (!topToken) return;
    void selectLaunch(topToken);
    document.getElementById("trade")?.scrollIntoView({ behavior: "smooth" });
  });

  $("createForm").addEventListener("submit", (e) => { e.preventDefault(); void onCreateSubmit(e as SubmitEvent); });
  $("createBtn").addEventListener("click", () => { void onCreateConfirm(); });
  document.querySelectorAll('input[name="createMode"]').forEach((r) =>
    r.addEventListener("change", () => {
      const mode = (document.querySelector('input[name="createMode"]:checked') as HTMLInputElement)?.value;
      $("firstBuyRow").style.display = mode === "atomic" ? "" : "none";
      delete ($("createBtn") as HTMLButtonElement).dataset.armed;
      ($("createBtn") as HTMLButtonElement).textContent = "Create Token (on-chain)";
      $("createPreview").innerHTML = "";
    }));

  $("buyTab").addEventListener("click", () => {
    tradeSide = "buy";
    $("buyTab").className = "active-buy";
    $("sellTab").className = "";
    $("amountLabel").textContent = "WETH amount";
    $("tradeBtn").textContent = "Buy Token";
    void refreshQuote();
  });
  $("sellTab").addEventListener("click", () => {
    tradeSide = "sell";
    $("sellTab").className = "active-sell";
    $("buyTab").className = "";
    $("amountLabel").textContent = `${selected?.symbol ?? "token"} amount`;
    $("tradeBtn").textContent = "Sell Token";
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
