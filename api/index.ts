/**
 * Vercel entry point (Node.js serverless function).
 *
 * `vercel.json` rewrites every path to this function so the connector's
 * public URLs stay at the root — Muse must see
 * https://<your-domain>/mcp, not /api/mcp.
 *
 * Deploy (needs Mitchell's Vercel auth — documented manual step):
 *   vercel link
 *   vercel env add PUBLIC_URL        # https://ff.your-domain.com
 *   vercel env add PAYMENT_URL       # Stripe payment link (or placeholder)
 *   vercel env add PREMIUM_SUBJECTS  # comma-separated, optional
 *   vercel deploy --prod
 */
import { app } from '../src/server.js';

export const config = { runtime: 'nodejs' };

export default app;
