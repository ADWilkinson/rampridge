import { productionDeps } from "./_lib/deps.js";
import { createWalletHandlers } from "./_lib/handlers/wallet.js";

const handlers = createWalletHandlers(productionDeps());

/** Issue a wallet proof message: ?address=0x..., Authorization: Bearer <token>. */
export async function GET(request: Request): Promise<Response> {
  return handlers.GET(request);
}

/** Submit a signed proof. Body: WalletProofRequest. */
export async function POST(request: Request): Promise<Response> {
  return handlers.POST(request);
}
