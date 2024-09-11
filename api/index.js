import axios from "axios";
import express from "express";
const app = express();

app.use(express.json());

app.all("/", async (req, res) => {
  return res.json({
    serverdata: (await axios.get("http://ip-api.com/json/")).data,
  });
});

app.all("/proxy/", async (req, res) => {
  try {
    if (req.method != "POST")
      return res.json({ error: "You should use POST method" });
    const { url, body, method, headers } = req.body;
    if (!url || !method)
      return res
        .status(400)
        .json({
          error:
            "A one or more field is missing, please check your method and url body value",
        });
    if (!isValidUrl(url))
      return res
        .status(400)
        .json({ error: "Invalid url It should use http/https protocol" });
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
      ].includes(method?.toString()?.toUpperCase())
    )
      return res
        .status(400)
        .json({
          error: method?.toString()?.toUpperCase() + " is an invalid method",
        }); //https://www.theserverside.com/blog/Coffee-Talk-Java-News-Stories-and-Opinions/HTTP-methods
    const resp = await axios.request({
      baseURL: url,
      headers: headers,
      body: body,
      method: method,
    });

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

const port = process.env.SERVER_PORT || process.env.PORT || 3000
app.listen(port, '0.0.0.0', () => {
  console.log("Listen on port " + port); 
});
const isValidUrl = (urlString) => {
  let url;
  try {
    url = new URL(urlString);
  } catch (e) {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
};
export default app
