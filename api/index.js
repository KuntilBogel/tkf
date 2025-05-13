import axios from "axios";
import express from "express";
import cheerio from "cheerio"; // For HTML parsing and manipulation
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

    // 1. Extract the target URL from the path
    // req.originalUrl includes query params, req.path does not.
    // We want everything after /cors/
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

    // If they forgot scheme, default to http://
    if (!/^https?:\/\//i.test(target)) {
      target = 'http://' + target;
    }

    if (!isValidUrl(target)) {
      return res.status(400).json({ error: "Invalid target URL or unsupported protocol." });
    }

    const targetUrl = new URL(target);

    // 2. Prepare the request to the target server
    const requestHeaders = { ...req.headers };
    // Delete headers that might cause issues or reveal proxying
    delete requestHeaders['host']; // Axios will set this based on targetUrl.hostname
    delete requestHeaders['origin'];
    delete requestHeaders['referer'];
    // Axios handles content-length automatically based on data
    delete requestHeaders['content-length'];


    const axiosConfig = {
      method: req.method,
      url: targetUrl.toString(),
      headers: requestHeaders,
      data: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      responseType: 'arraybuffer', // Crucial for handling binary and text data correctly
      validateStatus: function (status) {
        return true; // Handle all statuses ourselves
      },
      maxRedirects: 0, // Handle redirects manually
    };

    const upstreamResponse = await axios.request(axiosConfig);

    // 3. Process the upstream response
    const responseHeaders = new Headers(upstreamResponse.headers); // Use Headers API for convenience

    // Handle redirects: rewrite Location to come back through our proxy
    if (upstreamResponse.status >= 300 && upstreamResponse.status < 400 && responseHeaders.has('location')) {
      const locationHeader = responseHeaders.get('location');
      const absoluteRedirectUrl = new URL(locationHeader, targetUrl).toString();
      const proxiedRedirectUrl = `${hostOrigin}${PREFIX}${encodeURIComponent(absoluteRedirectUrl)}`;
      
      res.setHeader('Location', proxiedRedirectUrl);
      // Also set CORS headers for the redirect response itself
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*'); // Allow all headers for simplicity
      return res.status(upstreamResponse.status).end();
    }

    // Add CORS headers to the actual response
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Headers', '*'); // Or specify allowed headers
    responseHeaders.set('Access-Control-Expose-Headers', '*'); // Expose all headers


    // Copy all headers from upstream to our response
    // (after our modifications like CORS and potential Location rewrite)
    responseHeaders.forEach((value, name) => {
        // Skip content-encoding if we're decompressing (axios does this by default if not 'arraybuffer')
        // However, with arraybuffer, it should pass it through.
        // But if we modify content, content-length will be wrong.
        if (name.toLowerCase() === 'content-encoding' && responseHeaders.get('content-type')?.includes('text')) {
            // If we are going to modify text content, we should ideally handle decompression
            // and remove this header, or ensure our rewriting doesn't break it.
            // For simplicity now, we might remove it if we modify text.
            // Cheerio and string ops work on uncompressed data.
        } else if (name.toLowerCase() === 'content-length' && responseHeaders.get('content-type')?.includes('text')) {
            // Content-Length will change if we modify text, so remove it.
            // Express will set it automatically when res.send() is used with a string/buffer.
        } else {
            res.setHeader(name, value);
        }
    });


    const contentType = responseHeaders.get('content-type') || '';
    let responseBodyBuffer = Buffer.from(upstreamResponse.data);

    // Rewrite HTML resources
    if (contentType.includes('text/html')) {
      let htmlContent = responseBodyBuffer.toString('utf-8'); // Assuming UTF-8
      const $ = cheerio.load(htmlContent);

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
      rewriteAttribute('link[href]', 'href'); // More specific selector for link tags
      rewriteAttribute('a', 'href');
      rewriteAttribute('form', 'action');
      // For srcset on img and source
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
                return part; // return original part if invalid
              }
            })
            .join(', ');
          element.attr('srcset', newSrcset);
        }
      });


      const modifiedHtml = $.html();
      res.removeHeader('Content-Length'); // Express will recalculate
      return res.status(upstreamResponse.status).send(modifiedHtml);
    }

    // Rewrite TS/JS URLs in code
    const isCode = /\.(?:ts|js|mjs|cjs)$/i.test(targetUrl.pathname);
    if (isCode && (contentType.includes('javascript') || contentType.includes('typescript') || contentType.includes('text/plain'))) { // text/plain for some .js files
      let codeText = responseBodyBuffer.toString('utf-8');
      codeText = codeText.replace(
        /(["'`(])(https?:\/\/[^"'`)\s]+)(["'`)]?)/g, // Ensure space is also a delimiter in URLs within code
        (match, open, urlStr, close = '') => {
          try {
            // No need to resolve against base URL here, as these are expected to be absolute
            new URL(urlStr); // Validate it's a URL
            return `${open}${hostOrigin}${PREFIX}${encodeURIComponent(urlStr)}${close}`;
          } catch (e) {
            return match; // Not a valid URL, leave as is
          }
        }
      );
      // Also handle dynamic imports: import('...')
      codeText = codeText.replace(
        /import\s*\(\s*(["'`])(https?:\/\/[^"'`\s]+)\1\s*\)/g,
        (match, quote, urlStr) => {
          try {
            new URL(urlStr); // Validate
            return `import(${quote}${hostOrigin}${PREFIX}${encodeURIComponent(urlStr)}${quote})`;
          } catch (e) {
            return match;
          }
        }
      );
      res.removeHeader('Content-Length'); // Express will recalculate
      return res.status(upstreamResponse.status).send(codeText);
    }

    // Fallback: just pipe it through (send buffer)
    return res.status(upstreamResponse.status).send(responseBodyBuffer);

  } catch (error) {
    console.error("Proxying error:", error.message);
    if (error.response) { // Error from axios request to target
      console.error("Upstream error details:", {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data?.toString().slice(0, 200) + '...' // Log snippet of data
      });
      // Try to forward the error status and body from upstream if possible
      // Ensure CORS headers are on error responses too
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      // Check if error.response.data is a buffer or string before sending
      let errorData = error.response.data;
      if (Buffer.isBuffer(errorData)) {
          // Potentially try to convert to string if it's text, otherwise send as is
          // For simplicity, just send. Headers from upstream might be useful.
          Object.entries(error.response.headers).forEach(([key, value]) => res.setHeader(key, value));
          return res.status(error.response.status).send(errorData);
      }
      return res.status(error.response.status).json(errorData || { error: "Upstream request failed" });
    }
    // Generic server error
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(500).json({ error: "Proxy server error", details: error.message });
  }
});

// A simple root route to guide users
app.get('/', (req, res) => {
  res.send(`
    <h1>CORS Proxy</h1>
    <p>Usage: <code>${req.protocol}://${req.get('host')}/cors/<encoded_url></code></p>
    <p>Example: <a href="/cors/https%3A%2F%2Fjsonplaceholder.typicode.com%2Ftodos%2F1">/cors/https%3A%2F%2Fjsonplaceholder.typicode.com%2Ftodos%2F1</a></p>
    <p>To encode a URL, you can use JavaScript's <code>encodeURIComponent('your_url_here')</code>.</p>
  `);
});


const port = process.env.SERVER_PORT || process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`CORS Proxy server listening on port ${port}`);
  console.log(`Example: http://localhost:${port}/cors/encodeURIComponent('https://example.com')`);
});

export default app; // For testing or if used as a module
