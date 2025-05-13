import express from 'express';
import axios from 'axios';
import { URL } from 'url';
import https from 'https';

const app = express();

app.use(express.json());

// Create an agent that ignores SSL certificate errors
const agent = new https.Agent({
  rejectUnauthorized: false,  // Bypass SSL validation
});

// CORS proxy handler for /cors endpoint
app.all('/cors/*', async (req, res) => {
  const url = req.url;
  const origin = req.protocol + '://' + req.get('host');
  const prefix = '/cors/';
  
  // 1) If this isn't already a /cors/ request, redirect to /cors/<encoded full>
  if (!url.startsWith(prefix)) {
    return res.redirect(302, `${origin}${prefix}${encodeURIComponent(url)}`);
  }

  // 2) Decode the URL after "/cors/" and build a fresh URL
  const encoded = url.slice(prefix.length);
  let target = decodeURIComponent(encoded);
  
  // If the URL does not have a scheme, assume http://
  if (!/^https?:\/\//i.test(target)) {
    target = 'http://' + target;
  }
  const targetUrl = new URL(target);

  try {
    // 3) Create a proxied request and sanitize headers
    const proxiedReq = {
      method: req.method,
      url: targetUrl.toString(),
      headers: req.headers,
      data: req.body,
      httpsAgent: agent,  // Use the agent that ignores SSL errors
    };

    // Send the proxied request
    const response = await axios(proxiedReq);

    // Handle redirects in response headers
    let headers = { ...response.headers };

    if (response.status >= 300 && response.status < 400 && headers.location) {
      const loc = new URL(headers.location, targetUrl).toString();
      headers.location = `${origin}${prefix}${encodeURIComponent(loc)}`;
    }

    // Add CORS headers
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Headers'] = '*';

    const contentType = headers['content-type'] || '';

    // Handle HTML content rewriting
    if (contentType.includes('text/html')) {
      let body = response.data;
      body = rewriteHtmlLinks(body, origin, targetUrl);
      return res.status(response.status).set(headers).send(body);
    }

    // Handle JS/TS URL rewriting in the code
    if (/\.(ts|js)$/i.test(targetUrl.pathname) && contentType.includes('text')) {
      let codeText = response.data;
      codeText = codeText.replace(
        /(["'`(])(https?:\/\/[^"'`)]+)(["'`)]?)/g,
        (_, open, urlStr, close = '') =>
          `${open}${origin}${prefix}${encodeURIComponent(urlStr)}${close}`
      );
      return res.status(response.status).set(headers).send(codeText);
    }

    // Fallback: return response as-is for other content
    return res.status(response.status).set(headers).send(response.data);
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
});

// Function to rewrite resource URLs in HTML content
function rewriteHtmlLinks(body, origin, baseUrl) {
  return body.replace(/(src|href|action)="(https?:\/\/[^"'`]+)"/g, (_, attr, url) => {
    const abs = new URL(url, baseUrl).toString();
    const proxied = `${origin}/cors/${encodeURIComponent(abs)}`;
    return `${attr}="${proxied}"`;
  });
}

// Helper function to validate URLs
function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CORS Proxy server listening on port ${port}`);
});

export default app;
