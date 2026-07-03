import { handleUpload } from '@vercel/blob/client';

/*
  Credion MB — Financieringsrapport-tool
  /api/upload — Vercel Blob client upload endpoint.

  Belangrijk: de browserfunctie upload(...) verwacht exact de response
  van handleUpload(...). Een zelfgemaakte { clientToken } response kan
  leiden tot: "Vercel Blob: Failed to retrieve the client token".
*/

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;

  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB2_READ_WRITE_TOKEN;

    if (!blobToken) {
      return res.status(500).json({
        error:
          'BLOB_READ_WRITE_TOKEN ontbreekt. Koppel in Vercel een Blob Store aan dit project of voeg de environment variable handmatig toe.',
      });
    }

    const body = await readJsonBody(req);

    const jsonResponse = await handleUpload({
      body,
      request: req,
      token: blobToken,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let label = 'document';
        try {
          const parsed = clientPayload ? JSON.parse(clientPayload) : {};
          label = parsed.label || label;
        } catch {
          // clientPayload is optioneel; negeren als parsing mislukt.
        }

        return {
          allowedContentTypes: ['application/pdf', 'application/octet-stream'],
          maximumSizeInBytes: 50 * 1024 * 1024,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ label, pathname }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        console.log('Blob upload completed', {
          pathname: blob.pathname,
          size: blob.size,
          tokenPayload,
        });
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(400).json({
      error: error?.message || 'Vercel Blob upload-token genereren mislukt',
    });
  }
}
