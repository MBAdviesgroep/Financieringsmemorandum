/*
  Credion MB — Financieringsrapport-tool
  /api/health — status-endpoint voor snelle diagnose.
*/
export default async function handler(req, res) {
  return res.status(200).json({
    ok: true,
    hasBlobToken: Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB2_READ_WRITE_TOKEN),
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    runtime: 'vercel-serverless',
  });
}
