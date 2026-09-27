# Fantasy Football Connector — Muse pack README

Submission materials for the Muse connector directory live here:

- `SUBMISSION.md` — checklist, exact form fields, and the manual steps that need the owner's accounts
- `INSTALL.md` — install and first run guide for users
- `EVALS.md` — evaluation results (tests + live E2E)
- `SKILL.md` — the Muse skill text: how Muse should use these tools
- `security.md` — security model and credential handling
- `icon.png` — 512x512 directory icon (also served at `/icon.png`)

The connector itself is one MCP server: `POST /mcp`, Streamable HTTP with a single JSON response, no SSE, `GET /mcp` returns 405.
