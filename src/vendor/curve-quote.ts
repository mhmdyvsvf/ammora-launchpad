/** Vendored from the official Ammora SDK 0.3.9 examples (docs.ammora.org, source commit 0f3a73158fa5d86ed9f24ae1b2320e351e0e91e6). Unchanged logic, import paths adjusted for this Vite app. */
import {
  classifyAmmoraV4ExactInputFill,
  type AmmoraV4LaunchCurveClient,
} from "@ammora-protocol/sdk";

/** Read-model helper. The caller authenticates the Core and curve before displaying it. */
export const readCurveQuote = async (
  sdk: Pick<AmmoraV4LaunchCurveClient, "getStateAtBlock" | "quoteExactInputAtBlock">,
  blockNumber: bigint,
  request?: { amountIn: bigint; baseForQuote: boolean },
) => {
  const state = await sdk.getStateAtBlock(blockNumber);
  if (state.asOfBlock !== blockNumber) throw new Error("curve state is from a different block");
  if (!request || state.status !== 1) return { state, quote: null, fill: null };
  const quote = await sdk.quoteExactInputAtBlock(request.amountIn, request.baseForQuote, blockNumber);
  if (quote.asOfBlock !== blockNumber) throw new Error("curve quote is from a different block");
  return { state, quote, fill: classifyAmmoraV4ExactInputFill(quote, request.baseForQuote) };
};
