# Install: Fantasy Football Connector

## Option A: Muse directory (recommended)

Once listed, install from the Muse connector directory in one tap. No setup.

## Option B: Custom connector

1. In Muse, add a custom connector with the MCP endpoint: `https://<deploy>/mcp`
2. No auth needed for public Sleeper and ESPN leagues.
3. For private leagues, connect your credentials in Muse's Secure Credentials Store when prompted. Never paste ESPN cookies or Yahoo tokens into chat.

## Option C: Self host

```bash
git clone https://github.com/mitchellOpZero/muse-fantasy-connector
cd muse-fantasy-connector
npm install
cp .env.example .env   # edit values
npm run build
npm start
```

Point your MCP client at `http://localhost:8102/mcp`.

### Deploy to Vercel

```bash
vercel --prod
```

Set the env vars from `.env.example` in the Vercel dashboard. The repo ships `vercel.json` and `api/index.ts`.

## First run in Muse

Ask: "Connect my ESPN league 1446375" or "Connect my Sleeper league <id>".

Then: "Who should I start this week?", "Is this trade fair?", "Give me waiver targets", "Recap week 3 for the group chat".

## Paid tiers

Free covers public league reads. Pro ($8/mo) unlocks the trade analyzer, waiver targets, start/sit advice, and private leagues. Commissioner ($25/mo per league) adds the AI weekly recap. When a tool needs a paid tier, Muse shows a 402 message with a subscribe link. See PRICING.md.
