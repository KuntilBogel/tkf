import axios from 'axios';
import express from 'express';
const app = express();

app.use(express.json());

// Endpoint for checking server info
app.all("/", async (req, res) => {
  return res.json({
    serverdata: (await axios.get("http://ip-api.com/json/")).data,
  });
});

// CORS proxy endpoint
app.all("/cors", async (req, res) => {
  try {
    if (req.method !== "POST")
      return res.json({ error: "You should use POST method" });

    const { url, body, method, headers } = req.body;

    if (!url || !method)
      return res.status(400).json({
        error: "One or more fields are missing, please check your method and URL body value",
      });

    // Validate URL
    if (!isValidUrl(url))
      return res.status(400).json({ error: "Invalid URL. It should use http/https protocol" });

    // Validate HTTP method
    if (
      ![
        "GET",
        "PUT",
        "POST",
        "DELETE",
        "PATCH",
        "HEAD",
        "OPTIONS",
        "TRACE",
        "CONNECT",
      ].includes(method.toUpperCase())
    )
      return res.status(400).json({
        error: `${method.toUpperCase()} is an invalid HTTP method`,
      });

    // Make the request to the target URL
    const resp = await axios.request({
      url,
      method,
      headers,
      data: body,  // axios expects `data` for POST/PUT requests
    });

    // Return the response to the client
    return res.json({
      body: resp.data,
      headers: resp.headers,
      status: resp.status,
      statusText: resp.statusText,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.toString() });
  }
});

// Helper function to validate URLs
const isValidUrl = (urlString) => {
  let url;
  try {
    url = new URL(urlString);
  } catch (e) {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
};

// Start server
const port = process.env.SERVER_PORT || process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
});

export default app;
