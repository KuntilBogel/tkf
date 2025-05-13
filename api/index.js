import axios from "axios";
import express from "express";
import { load as cheerioLoad } from "cheerio"; // For HTML parsing and manipulation
import stream from "stream"; // For handling axios stream response
import { promisify } from "util"; // For promisifying pipeline

const app = express();
const pipeline = promisify(stream.pipeline);

// Middleware to handle raw body for forwarding,
// but also allow JSON for other potential routes (though not strictly needed for this proxy)
app.use(express.json());
app.use(express.raw({ type: '*/*', limit: '50mb' })); // Handle all content types as raw buffer

const PREFIX = '/cors/';

function isValidUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (e) {
    return false;
  }
}

app.all(`${PREFIX}*`, async (req, res) => {
  try {
    const hostOrigin = `${req.protocol}://${req.get('host')}`;

    let encodedTargetUrl = req.originalUrl.slice(PREFIX.length);
    if (!encodedTargetUrl) {
      return res.status(400).json({ error: "Target URL is missing after /cors/" });
    }

    let target;
    try {
      target = decodeURIComponent(encodedTargetUrl);
    } catch (e) {
      return res.status(400).json({ error: "Invalid URL encoding." });
    }

    if (!/^https?:\/\//i.test(target)) {
      target = 'http://' + target;
    }

    if (!isValidUrl(target)) {
      return res.status(400).json({ error: "Invalid target URL or unsupported protocol." });
    }

    const targetUrl = new URL(target);

    const requestHeaders = { ...req.headers };
    delete requestHeaders['host'];
    delete requestHeaders['origin'];
    delete requestHeaders['referer'];
    delete requestHeaders['content-length'];


    const axiosConfig = {
      method: req.method,
      url: targetUrl.toString(),
      headers: requestHeaders,
      data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      responseType: 'arraybuffer',
      validateStatus: function (status) {
        return true;
      },
      maxRedirects: 0,
    };

    const upstreamResponse = await axios.request(axiosConfig);
    const responseHeaders = new Headers(upstreamResponse.headers);

    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400 && responseHeaders.has('location')) {
      const locationHeader = responseHeaders.get('location');
      const absoluteRedirectUrl = new URL(locationHeader, targetUrl).toString();
      const proxiedRedirectUrl = `${hostOrigin}${PREFIX}${encodeURIComponent(absoluteRedirectUrl)}`;
      
      res.setHeader('Location', proxiedRedirectUrl);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      return res.status(upstreamResponse.status).end();
    }

    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Headers', '*');
    responseHeaders.set('Access-Control-Expose-Headers', '*');

    responseHeaders.forEach((value, name) => {
        if (name.toLowerCase() === 'content-encoding' && responseHeaders.get('content-type')?.includes('text')) {
            // Handled by text modification logic later if needed
        } else if (name.toLowerCase() === 'content-length' && responseHeaders.get('content-type')?.includes('text')) {
            // Will be removed if text is modified
        } else {
            res.setHeader(name, value);
        }
    });

    const contentType = responseHeaders.get('content-type') || '';
    let responseBodyBuffer = Buffer.from(upstreamResponse.data);

    if (contentType.includes('text/html')) {
      let htmlContent = responseBodyBuffer.toString('utf-8');
      const $ = cheerioLoad(htmlContent); // CORRECTED USAGE

      const rewriteAttribute = (selector, attr) => {
        $(selector).each((i, el) => {
          const element = $(el);
          const val = element.attr(attr);
          if (val) {
            try {
              const absoluteUrl = new URL(val, targetUrl).toString();
              const proxiedUrl = `${hostOrigin}${PREFIX}${encodeURIComponent(absoluteUrl)}`;
              element.attr(attr, proxiedUrl);
            } catch (e) {
              console.warn(`Skipping rewrite for invalid URL "${val}" in ${attr}: ${e.message}`);
            }
          }
        });
      };

      rewriteAttribute('img', 'src');
      rewriteAttribute('script', 'src');
      rewriteAttribute('link[href]', 'href');
      rewriteAttribute('a', 'href');
      rewriteAttribute('form', 'action');
      $('img, source').each((i, el) => {
        const element = $(el);
        const srcset = element.attr('srcset');
        if (srcset) {
          const newSrcset = srcset
            .split(',')
            .map(part => {
              const [urlPart, descriptor] = part.trim().split(/\s+/);
              try {
                const absoluteUrl = new URL(urlPart, targetUrl).toString();
                const proxiedUrl = `${hostOrigin}${PREFIX}${encodeURIComponent(absoluteUrl)}`;
                return descriptor ? `${proxiedUrl} ${descriptor}` : proxiedUrl;
              } catch (e) {
                console.warn(`Skipping rewrite for invalid URL "${urlPart}" in srcset: ${e.message}`);
                return part;
              }
            })
            .join(', ');
          element.attr('srcset', newSrcset);
        }
      });

      const modifiedHtml = $.html();
      res.removeHeader('Content-Length');
      if (res.getHeader('content-encoding')) res.removeHeader('content-encoding'); // Since we modified uncompressed content
      return res.status(upstreamResponse.status).send(modifiedHtml);
    }

    const isCode = /\.(?:ts|js|mjs|cjs)$/i.test(targetUrl.pathname);
    if (isCode && (contentType.includes('javascript') || contentType.includes('typescript') || contentType.includes('text/plain'))) {
      let codeText = responseBodyBuffer.toString('utf-8');
      codeText = codeText.replace(
        /(["'`(])(https?:\/\/[^"'`)\s]+)(["'`)]?)/g,
        (match, open, urlStr, close = '') => {
          try {
            new URL(urlStr);
            return `${open}${hostOrigin}${PREFIX}${encodeURIComponent(urlStr)}${close}`;
          } catch (e) {
            return match;
          }
        }
      );
      codeText = codeText.replace(
        /import\s*\(\s*(["'`])(https?:\/\/[^"'`\s]+)\1\s*\)/g,
        (match, quote, urlStr) => {
          try {
            new URL(urlStr);
            return `import(${quote}${hostOrigin}${PREFIX}${encodeURIComponent(urlStr)}${quote})`;
          } catch (e) {
            return match;
          }
        }
      );
      res.removeHeader('Content-Length');
      if (res.getHeader('content-encoding')) res.removeHeader('content-encoding'); // Since we modified uncompressed content
      return res.status(upstreamResponse.status).send(codeText);
    }

    return res.status(upstreamResponse.status).send(responseBodyBuffer);

  } catch (error) {
    console.error("Proxying error:", error.message);
    if (error.response) {
      console.error("Upstream error details:", {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data?.toString().slice(0, 200) + '...'
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      let errorData = error.response.data;
      Object.entries(error.response.headers).forEach(([key, value]) => {
        // Don't forward problematic headers like content-encoding if data is not actually encoded
        if (key.toLowerCase() !== 'transfer-encoding' && key.toLowerCase() !== 'content-encoding') {
            res.setHeader(key, value);
        }
      });
      return res.status(error.response.status).send(errorData);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(500).json({ error: "Proxy server error", details: error.message });
  }
});

app.get('/', (req, res) => {
  const exampleEncodedUrl = encodeURIComponent('https://jsonplaceholder.typicode.com/todos/1');
  res.send(`
    <h1>CORS Proxy</h1>
    <p>Usage: <code>${req.protocol}://${req.get('host')}/cors/<encoded_url></code></p>
    <p>Example: <a href="/cors/${exampleEncodedUrl}">/cors/${exampleEncodedUrl}</a></p>
    <p>To encode a URL, you can use JavaScript's <code>encodeURIComponent('your_url_here')</code> in the browser console.</p>
  `);
});

const port = process.env.SERVER_PORT || process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`CORS Proxy server listening on port ${port}`);
  console.log(`Example: http://localhost:${port}/cors/encodeURIComponent('https://example.com')`);
});

export default app;
