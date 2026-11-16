// Diagnostic: why did the on-chain LaunchCreated scan find 0 events?
// Run from the app dir so node resolves viem + SDK from node_modules:
//   node scripts/diag.mjs
import { createPublicClient, http, parseAbiItem, keccak256, toHex } from "viem";
import {
  ammoraLaunchFactoryV4Abi, giwaSepoliaAutoRoute, resolveAmmoraFinalizedHead,
} from "@ammora-protocol/sdk";
import { writeFileSync } from "node:fs";

const RPC = "https://sepolia-rpc.giwa.io";
const FACTORY = "0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA";
const START = 36_220_000n;
const out = [];
const log = (...a) => { const s = a.join(" "); out.push(s); console.error(s); };

const client = createPublicClient({
  chain: { id: 91342, name: "GIWA Sepolia", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } },
  transport: http(RPC, { retryCount: 0 }),
});

const latest = await client.getBlockNumber();
log("latest block:", latest.toString());
const fin = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
log("finalized head:", fin.toString());

const abiEvent = ammoraLaunchFactoryV4Abi.find((e) => e.type === "event" && e.name === "LaunchCreated");
log("factory ABI LaunchCreated:", JSON.stringify(abiEvent));
const sigFromAbi = `LaunchCreated(${abiEvent.inputs.map((i) => i.type).join(",")})`;
log("sig from ABI:", sigFromAbi, "topic0:", keccak256(toHex(sigFromAbi)));
const myEvent = parseAbiItem("event LaunchCreated(address indexed token,address indexed curve,address indexed creator,uint256 configId,bytes32 configHash,uint16 protocolVersion,string metadataURI)");
const mySig = "LaunchCreated(address,address,address,uint256,bytes32,uint16,string)";
log("my sig topic0:", keccak256(toHex(mySig)), "| match:", keccak256(toHex(sigFromAbi)) === keccak256(toHex(mySig)));

// Last 50k blocks with the ABI event object directly (chunked at 10k, the RPC cap)
let count50k = 0;
let sample = null;
for (let from = latest - 50_000n; from <= latest; from += 10_000n) {
  const to = from + 10_000n - 1n > latest ? latest : from + 10_000n - 1n;
  const logs = await client.getLogs({ address: FACTORY, event: myEvent, fromBlock: from, toBlock: to });
  count50k += logs.length;
  if (!sample && logs.length) sample = logs[0];
}
log("last-50k LaunchCreated count:", count50k);
if (sample) log("sample:", JSON.stringify(sample.args, (_, v) => typeof v === "bigint" ? v.toString() : v));

// Full scan, chunked, counting
let total = 0;
let chunks = 0;
for (let from = START; from <= fin; from += 10_000n) {
  const to = from + 10_000n - 1n > fin ? fin : from + 10_000n - 1n;
  const logs = await client.getLogs({ address: FACTORY, event: myEvent, fromBlock: from, toBlock: to });
  total += logs.length;
  chunks++;
  if (chunks % 100 === 0) log(`scan progress: ${chunks} chunks, ${total} events so far (from=${from})`);
}
log("FULL SCAN chunks:", chunks, "total LaunchCreated:", total);
writeFileSync("/tmp/smoke/diag.json", JSON.stringify({ latest: latest.toString(), finalized: fin.toString(), last50k: count50k, chunks, total }, null, 2));
log("DIAG DONE");
