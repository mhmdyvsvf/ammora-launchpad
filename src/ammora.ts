// Ammora Launchpad — SDK layer (GIWA Sepolia, chain 91342).
// Every function here calls @ammora-protocol/sdk 0.3.9 exactly the way the
// official examples do (vendored helpers in src/vendor/). No simulation:
// reads come from the GIWA RPC, writes are real signed transactions.
import {
  AmmoraDataApiClient,
  AmmoraV4LaunchCurveClient,
  PreparedExactInputSwap,
  ammoraLaunchFactoryV4Abi,
  buildRegisterConfigAndCreateAmmoraV4Launch,
  feeVaultAbi,
  getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteDeployment,
  parseAmmoraV4ConfigCreatedReceipt,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4MigratedReceipt,
  parseAmmoraV4SwapReceipt,
  resolveAmmoraFinalizedHead,
  verifyAmmoraV4CoreAtBlock,
  type AmmoraV4ConfigSnapshot,
  type CreateConfigAndPoolWithFirstBuyPlan,
} from "@ammora-protocol/sdk";
import {
  createPublicClient, createWalletClient, custom, erc20Abi,
  encodeFunctionData, parseAbi, getAddress, zeroAddress,
  type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { pacedHttp } from "./vendor/rpc.js";
import { planCurveAtBlock } from "./vendor/curve-plan.js";
import { parseTeamRecipientPolicy, planTeamConfig, type TeamRecipientPolicy } from "./vendor/policy.js";
import { planTeamAtomicFromCatalog } from "./vendor/builtin-first-buy.js";

export const CHAIN_ID = 91342;
export const RPC_URL = "https://sepolia-rpc.giwa.io";
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";
export const DATA_API_URL = "https://ammora-giwa-sepolia-data.fly.dev";
export const TEMPLATE_ID = 6n;
export const START_BLOCK = 36_220_000n;

// Reviewed catalog addresses (giwaSepoliaAutoRouteDeployment). The catalog is
// the source of truth; the pins below are asserted against it at startup so a
// different SDK version can never silently point this app at other contracts.
const DEPLOYMENT = giwaSepoliaAutoRouteDeployment;
export const REGISTRY = DEPLOYMENT.contracts.launch.configRegistry as Address;
export const FACTORY = DEPLOYMENT.contracts.launch.factory as Address;
export const GRADUATION_ADAPTER = DEPLOYMENT.contracts.launch.graduationAdapter as Address;
export const FEE_POLICY = DEPLOYMENT.contracts.launch.feePolicy as Address;
export const WETH = "0x4200000000000000000000000000000000000006" as Address;
export const FIRST_BUY_EXECUTOR = "0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451" as Address;
const CORE = { configRegistry: REGISTRY, launchFactory: FACTORY, graduationAdapter: GRADUATION_ADAPTER, feePolicy: FEE_POLICY };

const PINNED: Record<string, Address> = {
  registry: "0x6d043014972b87406C4757a5f2d655A24e0b0aF9",
  factory: "0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA",
  firstBuyExecutor: FIRST_BUY_EXECUTOR,
  feePolicy: "0x17B44C14F640fD429740FA3220f47a567c62725C",
  graduationAdapter: "0xF1A0f23036Aae88EEcecd1D9205Dd78c388fe263",
  weth: "0x4200000000000000000000000000000000000006",
};
for (const [key, pinned] of Object.entries(PINNED)) {
  const live = { registry: REGISTRY, factory: FACTORY, firstBuyExecutor: FIRST_BUY_EXECUTOR, feePolicy: FEE_POLICY, graduationAdapter: GRADUATION_ADAPTER, weth: WETH }[key]!;
  if (live.toLowerCase() !== pinned.toLowerCase()) {
    throw new Error(`SDK catalog address mismatch for ${key}: catalog ${live} != pinned ${pinned}. Refusing to run.`);
  }
}
if (DEPLOYMENT.chain.id !== CHAIN_ID) throw new Error(`SDK catalog chain ${DEPLOYMENT.chain.id} != ${CHAIN_ID}`);

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${EXPLORER_URL}/address/${addr}`;
export const explorerToken = (addr: string) => `${EXPLORER_URL}/token/${addr}`;

export function getPublicClient(): PublicClient {
  return createPublicClient({
    chain: {
      id: CHAIN_ID, name: "GIWA Sepolia",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    },
    transport: pacedHttp(RPC_URL, 400),
  });
}

/** Same public client, but receipt waits require 13 confirmations (the
 * reviewed finality window for GIWA), like the official safe-swap example. */
export function getExecutionClient(client: PublicClient): PublicClient {
  return client.extend(() => ({
    waitForTransactionReceipt: (request: Parameters<PublicClient["waitForTransactionReceipt"]>[0]) =>
      client.waitForTransactionReceipt({ ...request, confirmations: 13, retryCount: 0, timeout: 120_000, pollingInterval: 6000 }),
  })) as unknown as PublicClient;
}

export function getWalletClient(account: Address): WalletClient {
  if (!window.ethereum) throw new Error("No injected wallet found (window.ethereum). Open this page in a wallet browser.");
  return createWalletClient({
    account,
    chain: {
      id: CHAIN_ID, name: "GIWA Sepolia",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [RPC_URL] } },
    },
    transport: custom(window.ethereum),
  });
}

export async function switchToGiwa(): Promise<void> {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x164ce" }] });
  } catch (e: unknown) {
    const err = e as { code?: number };
    if (err?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: "0x164ce", chainName: "GIWA Sepolia", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER_URL] }],
      });
    } else throw e;
  }
}

export async function connectWallet(): Promise<Address> {
  if (!window.ethereum) throw new Error("No injected wallet found (window.ethereum). Open this page in a wallet browser.");
  await switchToGiwa();
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
  if (!accounts?.length) throw new Error("Wallet connection rejected.");
  return getAddress(accounts[0]!);
}

export async function finalizedHead(client: PublicClient): Promise<bigint> {
  return resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
}

export async function verifyCore(client: PublicClient, head: bigint) {
  return verifyAmmoraV4CoreAtBlock(client, CORE, head);
}

export async function getTemplate(client: PublicClient, head: bigint): Promise<AmmoraV4ConfigSnapshot> {
  return getAmmoraV4ConfigAtBlock(client, REGISTRY, TEMPLATE_ID, head);
}

export async function getNextConfigId(client: PublicClient, head: bigint): Promise<bigint> {
  return getAmmoraV4NextConfigId(client, REGISTRY, head);
}

export type LaunchSummary = {
  token: Address; curve: Address; creator: Address; configId: bigint;
  name: string; symbol: string; decimals: number; status: number;
  sqrtPrice: bigint; currentFeeBps: number; baseReserve: bigint; quoteReserve: bigint;
  migrationQuoteThreshold: bigint; migrationBaseThreshold: bigint;
  canonicalPool: Address; partnerRecipient: Address; feeVault: Address;
  feePolicy: Address; feePolicyVersion: Hex; metadataURI: string;
};

const LAUNCH_CREATED = ammoraLaunchFactoryV4Abi.find(
  (e) => e.type === "event" && e.name === "LaunchCreated",
) as Extract<(typeof ammoraLaunchFactoryV4Abi)[number], { type: "event"; name: "LaunchCreated" }>;
// NOTE (2026-11-16): protocolVersion is uint16, not uint8. A hand-written
// "uint8" event string produces a different topic0 and the getLogs filter
// silently matches nothing — the scan found 0 launches for exactly this
// reason. Taking the event from the factory ABI makes a repeat impossible.

async function enrichLaunch(client: PublicClient, head: bigint, base: { token: Address; curve: Address; creator: Address; configId: bigint; metadataURI: string; statusHint?: number }): Promise<LaunchSummary | null> {
  try {
    const sdk = new AmmoraV4LaunchCurveClient(client, base.curve, { launchFactory: FACTORY, feePolicy: FEE_POLICY });
    const [state, name, symbol, decimals] = await Promise.all([
      sdk.getStateAtBlock(head),
      client.readContract({ address: base.token, abi: erc20Abi, functionName: "name", blockNumber: head }).catch(() => "?"),
      client.readContract({ address: base.token, abi: erc20Abi, functionName: "symbol", blockNumber: head }).catch(() => "?"),
      client.readContract({ address: base.token, abi: erc20Abi, functionName: "decimals", blockNumber: head }).catch(() => 9),
    ]);
    return {
      token: base.token, curve: base.curve, creator: base.creator, configId: state.configId,
      name: String(name), symbol: String(symbol), decimals: Number(decimals),
      status: state.status, sqrtPrice: state.sqrtPrice, currentFeeBps: state.currentFeeBps,
      baseReserve: state.baseReserve, quoteReserve: state.quoteReserve,
      migrationQuoteThreshold: state.migrationQuoteThreshold,
      migrationBaseThreshold: state.migrationBaseThreshold,
      canonicalPool: state.canonicalPool, partnerRecipient: state.partnerRecipient,
      feeVault: state.feeVault, feePolicy: state.feePolicy, feePolicyVersion: state.feePolicyVersion,
      metadataURI: base.metadataURI,
    };
  } catch {
    return null;
  }
}

async function enrichMany(head: bigint, bases: Array<{ token: Address; curve: Address; creator: Address; configId: bigint; metadataURI: string; statusHint?: number }>, cap: number, onProgress?: (done: number, total: number, phase: "enrich") => void, onLaunch?: (l: LaunchSummary) => void): Promise<LaunchSummary[]> {
  const out: LaunchSummary[] = [];
  const queue = bases.slice(0, cap);
  let i = 0;
  // Each worker gets its OWN public client (own paced transport queue).
  // Sharing one client serializes all calls at 400ms — 24 curves would take
  // minutes. Four parallel clients stay inside the <=4 workers rule.
  const workers = Array.from({ length: 4 }, async () => {
    const workerClient = getPublicClient();
    while (i < queue.length) {
      const item = queue[i++]!;
      const enriched = await enrichLaunch(workerClient, head, item);
      if (enriched) {
        out.push(enriched);
        // Incremental render: the UI shows each token as soon as its data
        // is read, instead of a blank list for the whole ~2 min load.
        onProgress?.(out.length, queue.length, "enrich");
        onLaunch?.(enriched);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export async function listLaunches(
  _client: PublicClient, head: bigint,
  onProgress?: (done: number, total: number, phase: "scan" | "enrich") => void,
  onLaunch?: (l: LaunchSummary) => void,
): Promise<LaunchSummary[]> {
  // Path 1: Ammora Data API (SDK client). It is down (503) as of 2026-11-16,
  // so this usually falls through to the on-chain scan below. The fetch has
  // no built-in timeout, so race it against 15s — a hung API must never
  // freeze the launch list.
  try {
    const api = new AmmoraDataApiClient(DATA_API_URL);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const items: Array<{ address: Address; curveAddress: Address; creatorAddress: Address; configId: string; metadataUri: string; status: string }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const res = await api.getLaunches({ chainId: "91342", cursor, signal: controller.signal });
        items.push(...(res.items as typeof items));
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
    if (items.length) {
      const statusMap: Record<string, number> = { PENDING: 0, ACTIVE: 1, MIGRATION_READY: 2, MIGRATED: 3, FLAGGED: 0 };
      const bases = items.map((it) => ({
        token: getAddress(it.address), curve: getAddress(it.curveAddress),
        creator: getAddress(it.creatorAddress), configId: BigInt(it.configId),
        metadataURI: it.metadataUri ?? "", statusHint: statusMap[it.status] ?? 0,
      }));
      onProgress?.(0, bases.length, "enrich");
      const enriched = await enrichMany(head, bases, 24, onProgress, onLaunch);
      if (enriched.length) return enriched.sort((a, b) => Number(b.quoteReserve - a.quoteReserve));
    }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Data API unavailable — on-chain scan below is the reviewed fallback.
  }

  // Path 2: on-chain scan of LaunchCreated events from the factory.
  // 526 x 10k-block chunks over the full range. Run as 4 parallel workers,
  // each with its own paced client — a single shared client would serialize
  // all 526 getLogs calls at 400ms (~4 min for the scan alone).
  const found = new Map<string, { token: Address; curve: Address; creator: Address; configId: bigint; metadataURI: string }>();
  const CHUNK = 10_000n;
  const SCAN_WORKERS = 4;
  const totalRange = head - START_BLOCK + 1n;
  const rangePerWorker = totalRange / BigInt(SCAN_WORKERS) + 1n;
  const scanRanges = Array.from({ length: SCAN_WORKERS }, (_, w) => {
    const from = START_BLOCK + rangePerWorker * BigInt(w);
    const to = w === SCAN_WORKERS - 1 ? head : from + rangePerWorker - 1n;
    return { from, to };
  });
  await Promise.all(scanRanges.map(async ({ from: rangeFrom, to: rangeTo }) => {
    const workerClient = getPublicClient();
    for (let from = rangeFrom; from <= rangeTo; from += CHUNK) {
      const to = from + CHUNK - 1n > rangeTo ? rangeTo : from + CHUNK - 1n;
      const logs = await workerClient.getLogs({ address: FACTORY, event: LAUNCH_CREATED, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const a = log.args;
        if (!a.token || !a.curve || !a.creator) continue;
        found.set(a.curve.toLowerCase(), {
          token: getAddress(a.token), curve: getAddress(a.curve), creator: getAddress(a.creator),
          configId: a.configId ?? 0n, metadataURI: a.metadataURI ?? "",
        });
      }
      // Scan phase: total is unknown while scanning, so report the phase
      // explicitly. Reporting (found, found) here used to render as
      // "loading 18/18..." — looking finished while enrichment had not
      // even started.
      onProgress?.(found.size, 0, "scan");
    }
  }));
  const bases = [...found.values()].sort((a, b) => Number(b.configId - a.configId));
  onProgress?.(0, bases.length, "enrich");
  return enrichMany(head, bases, 24, onProgress, onLaunch);
}

export async function getCurveQuote(
  client: PublicClient, curve: Address, head: bigint,
  amountIn: bigint, isSell: boolean, account: Address | null,
  slippageBps = 100,
) {
  const state0 = await new AmmoraV4LaunchCurveClient(client, curve, { launchFactory: FACTORY, feePolicy: FEE_POLICY }).getStateAtBlock(head);
  const tokenIn = isSell ? state0.baseToken : state0.quoteToken;
  const block = await client.getBlock({ blockNumber: head });
  const plan = await planCurveAtBlock(client, CORE, curve, {
    blockNumber: head, tokenIn, amountIn,
    recipient: account ?? zeroAddress,
    deadline: block.timestamp + 1800n, slippageBps,
  });
  return { quote: plan.quote, fill: plan.fill, state: plan.state, tokenOut: plan.tokenOut, baseForQuote: plan.baseForQuote };
}

export async function simulateTx(client: PublicClient, account: Address, tx: { to: Address; data: Hex; value?: bigint }) {
  await client.call({ account, to: tx.to, data: tx.data, value: tx.value ?? 0n });
}

export async function sendAndConfirm(
  client: PublicClient, wallet: WalletClient, account: Address,
  tx: { to: Address; data: Hex; value?: bigint },
) {
  const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to: tx.to, data: tx.data, value: tx.value ?? 0n });
  const exec = getExecutionClient(client);
  const receipt = await exec.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return { hash, receipt };
}

/** Personal recipient policy: Boss is config owner, partner, LP partner and
 * leftover receiver for his own launchpad. Built from the LIVE template hash. */
export function buildPersonalPolicy(account: Address, templateHash: Hex): TeamRecipientPolicy {
  return parseTeamRecipientPolicy({
    schemaVersion: 1, chainId: CHAIN_ID, registry: REGISTRY,
    templateId: TEMPLATE_ID.toString(), templateHash,
    configOwner: account, partnerRecipient: account,
    liquidityPartner: account, leftoverReceiver: account,
  });
}

export type QuickCreatePreview = {
  tx: { to: Address; data: Hex; value: bigint };
  totalSupply: bigint; feeClaimer: Address;
  economics: { saleAllocationRaw: bigint; grossMigrationBaseRaw: bigint; grossMigrationQuoteRaw: bigint; migrationQuoteFeeRaw: bigint; quoteSurplusToProtocolRaw: bigint; lockedBaseRaw: bigint; totalSupplyRaw: bigint };
  reviewHash: Hex;
};

export async function previewQuickCreate(
  client: PublicClient, account: Address, head: bigint,
  input: { name: string; symbol: string; metadataURI: string; saleSupplyRaw: bigint; quoteThresholdRaw: bigint },
): Promise<QuickCreatePreview> {
  const template = await getTemplate(client, head);
  if (!template.enabled) throw new Error("Template #6 is disabled on-chain.");
  const policy = buildPersonalPolicy(account, template.configHash);
  const team = planTeamConfig(template, policy, { chainId: CHAIN_ID, registry: REGISTRY }, input.saleSupplyRaw, input.quoteThresholdRaw);
  const built = buildRegisterConfigAndCreateAmmoraV4Launch(team.config, team.curve, {
    name: input.name, symbol: input.symbol, metadataURI: input.metadataURI,
    creatorMetadataURI: input.metadataURI, tokenDecimals: team.config.tokenDecimals,
    callback: zeroAddress, callbackData: "0x",
  });
  const tx = { to: FACTORY, data: built.data, value: built.value };
  await simulateTx(client, account, tx);
  return { tx, totalSupply: team.config.totalSupply, feeClaimer: template.identity.feeClaimer, economics: team.economics, reviewHash: team.reviewHash };
}

export async function executeQuickCreate(
  client: PublicClient, wallet: WalletClient, account: Address, preview: QuickCreatePreview,
) {
  const { hash, receipt } = await sendAndConfirm(client, wallet, account, preview.tx);
  const config = parseAmmoraV4ConfigCreatedReceipt(receipt, REGISTRY);
  const launch = parseAmmoraV4LaunchCreatedReceipt(receipt, FACTORY);
  if (launch.configId !== config.configId) throw new Error(`Receipt mismatch: launch config ${launch.configId} != config ${config.configId} for ${hash}`);
  if (launch.creator.toLowerCase() !== account.toLowerCase()) throw new Error(`Receipt creator ${launch.creator} != ${account}`);
  return { hash, configId: launch.configId, token: launch.token, curve: launch.curve, feeClaimer: config.feeClaimer };
}

export type AtomicPreview = {
  plan: CreateConfigAndPoolWithFirstBuyPlan;
  reviewed: { parameters: { firstBuys: readonly { includedQuoteAmountRaw: bigint; minimumBaseAmountOutRaw: bigint }[] }; reviewHash: Hex };
  helper: Address;
};

export async function previewAtomicCreate(
  client: PublicClient, account: Address, head: bigint,
  input: { saleSupplyRaw: bigint; quoteThresholdRaw: bigint; name: string; symbol: string; metadataURI: string; quoteRaw: bigint; minimumBaseRaw: bigint; maxFeePerGasWei: bigint; deadline: bigint },
): Promise<AtomicPreview> {
  const template = await getTemplate(client, head);
  if (!template.enabled) throw new Error("Template #6 is disabled on-chain.");
  const policy = buildPersonalPolicy(account, template.configHash);
  let maxFee = input.maxFeePerGasWei;
  if (maxFee === 0n) {
    const gasPrice = await client.getGasPrice();
    maxFee = gasPrice * 2n;
  }
  let planned: Awaited<ReturnType<typeof planTeamAtomicFromCatalog>>;
  try {
    planned = await planTeamAtomicFromCatalog(client, head, policy, {
      account, saleSupplyRaw: input.saleSupplyRaw, quoteThresholdRaw: input.quoteThresholdRaw,
      name: input.name, symbol: input.symbol, metadataURI: input.metadataURI,
      quoteRaw: input.quoteRaw, minimumBaseRaw: input.minimumBaseRaw,
      maxFeePerGasWei: maxFee, deadline: input.deadline,
    });
  } catch (e) {
    const err = e as { code?: string };
    if (err?.code === "AMMORA_PORTABLE_INSUFFICIENT_QUOTE_BALANCE") {
      throw new Error("Saldo WETH wallet kurang untuk first buy ini. Wrap ETH menjadi WETH dulu (panel Trade), lalu coba lagi.");
    }
    throw e;
  }
  const { deployment, helper, reviewed, plan } = planned;
  void deployment;
  return { plan, reviewed: reviewed as AtomicPreview["reviewed"], helper: helper as Address };
}

export async function executeAtomicCreate(
  client: PublicClient, wallet: WalletClient, account: Address, preview: AtomicPreview,
) {
  const { plan, helper } = preview;
  const tx = { to: plan.transaction.to as Address, data: plan.transaction.data as Hex, value: (plan.transaction as { value?: bigint }).value ?? 0n };
  if (plan.status === "APPROVAL_REQUIRED") {
    const { hash } = await sendAndConfirm(client, wallet, account, tx);
    return { approvalConfirmed: true, hash, token: null as Address | null, curve: null as Address | null, boughtBaseRaw: null as bigint | null };
  }
  const { hash, receipt } = await sendAndConfirm(client, wallet, account, tx);
  const config = parseAmmoraV4ConfigCreatedReceipt(receipt, REGISTRY);
  const launch = parseAmmoraV4LaunchCreatedReceipt(receipt, FACTORY);
  const swap = parseAmmoraV4SwapReceipt(receipt, launch.curve);
  const firstBuy = preview.reviewed.parameters.firstBuys[0]!;
  if (launch.configId !== config.configId) throw new Error(`Receipt mismatch: launch config ${launch.configId} != config ${config.configId}`);
  if (swap.trader.toLowerCase() !== helper.toLowerCase()) throw new Error(`Swap trader ${swap.trader} != first-buy executor ${helper}`);
  if (swap.recipient.toLowerCase() !== account.toLowerCase()) throw new Error(`Swap recipient ${swap.recipient} != ${account}`);
  if (swap.baseForQuote) throw new Error("Atomic first buy must be quote -> base");
  if (swap.consumedAmountIn <= 0n) throw new Error("Atomic first buy consumed 0");
  if (swap.amountOut < firstBuy.minimumBaseAmountOutRaw) throw new Error(`First buy got ${swap.amountOut} < minimum ${firstBuy.minimumBaseAmountOutRaw}`);
  return { approvalConfirmed: false, hash, token: launch.token, curve: launch.curve, boughtBaseRaw: swap.amountOut };
}

export async function getBalances(client: PublicClient, account: Address, token?: Address) {
  const [eth, weth, tokenBalance] = await Promise.all([
    client.getBalance({ address: account }),
    client.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    token ? client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account] }).catch(() => 0n) : Promise.resolve(0n),
  ]);
  return { eth, weth: weth as bigint, tokenBalance: tokenBalance as bigint };
}

export async function allowanceOf(client: PublicClient, token: Address, owner: Address, spender: Address): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }) as Promise<bigint>;
}

export async function approveToken(client: PublicClient, wallet: WalletClient, account: Address, token: Address, spender: Address, amount: bigint) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
  return sendAndConfirm(client, wallet, account, { to: token, data });
}

export async function wrapEth(client: PublicClient, wallet: WalletClient, account: Address, wei: bigint) {
  const data = encodeFunctionData({ abi: parseAbi(["function deposit() payable"]), functionName: "deposit" });
  return sendAndConfirm(client, wallet, account, { to: WETH, data, value: wei });
}

export async function executeTrade(
  client: PublicClient, wallet: WalletClient, account: Address,
  curve: Address, tokenIn: Address, amountIn: bigint, slippageBps = 100,
) {
  const exec = getExecutionClient(client);
  const prepared = await PreparedExactInputSwap.create({
    client: exec, chainId: CHAIN_ID, payer: account, quoteTtlMs: 30_000,
    createPlan: async () => {
      const blockNumber = await finalizedHead(client);
      const block = await client.getBlock({ blockNumber });
      const plan = await planCurveAtBlock(client, CORE, curve, {
        blockNumber, tokenIn, amountIn, recipient: account,
        deadline: block.timestamp + 20n * 60n, slippageBps,
      });
      return {
        transaction: plan.transaction,
        approvalRequirements: plan.approvalRequirements,
        quoteBlockNumber: blockNumber,
        quote: {
          model: "dbc" as const, pool: curve, tokenIn, inputAsset: "erc20" as const,
          tokenOut: plan.tokenOut, amountIn,
          fillableAmountIn: plan.quote.amountIn, remainderAmountIn: plan.quote.amountLeft,
          expectedAmountOut: plan.quote.amountOut, minimumAmountOut: plan.quote.minimumAmountOut,
          feeAmount: plan.quote.fee, feeToken: null, priceImpactBps: null, recipient: account,
          details: {
            snapshotBlock: blockNumber, snapshotHash: block.hash,
            policy: giwaSepoliaAutoRoute.finality,
            note: "Confirmed snapshot quote, not a latest execution-price guarantee; current-state simulation and minimum output remain mandatory.",
            quote: plan.quote,
          },
        },
      };
    },
  });
  const result = await prepared.execute(wallet, {
    onStatus: (s) => console.log(`[swap] ${JSON.stringify(s, (_, v) => typeof v === "bigint" ? v.toString() : v)}`),
  });
  if (result.amountReceived === null) throw new Error("Swap succeeded but receipt-block output reconciliation was unavailable");
  return { hash: result.hash, amountReceived: result.amountReceived, receipt: result.receipt };
}

export async function migrateCurve(client: PublicClient, wallet: WalletClient, account: Address, curve: Address, head: bigint) {
  const sdk = new AmmoraV4LaunchCurveClient(client, curve, { launchFactory: FACTORY, feePolicy: FEE_POLICY });
  const state = await sdk.getStateAtBlock(head);
  if (state.status === 3) return { alreadyMigrated: true, canonicalPool: state.canonicalPool, hash: null as string | null };
  if (state.status !== 2) throw new Error(`Curve status ${state.status} is not ReadyToMigrate`);
  const plan = await sdk.planMigrateAtBlock(head);
  const tx = { to: plan.transaction.to as Address, data: plan.transaction.data as Hex, value: (plan.transaction as { value?: bigint }).value ?? 0n };
  const { hash, receipt } = await sendAndConfirm(client, wallet, account, tx);
  const migrated = parseAmmoraV4MigratedReceipt(receipt, curve);
  return { alreadyMigrated: false, canonicalPool: migrated.canonicalPool, hash };
}

export async function getFeeClaimable(client: PublicClient, feeVault: Address, beneficiary: Address, baseToken: Address, head: bigint) {
  const [quote, base] = await Promise.all([
    client.readContract({ address: feeVault, abi: feeVaultAbi, functionName: "claimable", args: [WETH, beneficiary], blockNumber: head }),
    client.readContract({ address: feeVault, abi: feeVaultAbi, functionName: "claimable", args: [baseToken, beneficiary], blockNumber: head }),
  ]);
  return { quote: quote as bigint, base: base as bigint };
}

export async function claimFees(client: PublicClient, wallet: WalletClient, account: Address, feeVault: Address, feeToken: Address) {
  const data = encodeFunctionData({ abi: feeVaultAbi, functionName: "claimFor", args: [feeToken, account, account] });
  return sendAndConfirm(client, wallet, account, { to: feeVault, data });
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}
