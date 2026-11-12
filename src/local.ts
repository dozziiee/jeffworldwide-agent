// Local entry point: `npm run dev`. On Vercel, api/index.ts is used instead.

import app from "./app";

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Jeffworldwide MCP server on http://localhost:${port}/mcp`));
