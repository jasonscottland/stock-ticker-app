// This script talks to the Alpha Vantage API (https://www.alphavantage.co)
// to look up a stock's current price and its last month of daily closing
// prices, then draws a simple line chart on a <canvas>.
//
// ALPHA_VANTAGE_API_KEY comes from config.js (loaded before this file).

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

// The free Alpha Vantage tier only allows 1 request/second and 25
// requests/day total, and it just replies with a friendly-sounding
// message (not an HTTP error) when you go over. To work within that:
//   1. We space out actual network requests by at least this many ms.
//   2. We cache every successful response in localStorage, so re-searching
//      the same stock (very common while developing/testing) doesn't
//      use up another request.
const MIN_REQUEST_GAP_MS = 1200;
const CACHE_KEY_PREFIX = "stockTicker_cache_";

// How long cached data is considered "fresh" before we call the API
// again. Daily history only changes once a day after the market closes,
// and a company-name-to-symbol match basically never changes, so those
// can be cached much longer than the current price.
const FRESHNESS_MS = {
  SYMBOL_SEARCH: 24 * 60 * 60 * 1000, // 1 day
  GLOBAL_QUOTE: 15 * 60 * 1000, // 15 minutes
  TIME_SERIES_DAILY: 24 * 60 * 60 * 1000, // 1 day
};

let lastRequestTime = 0;

// Grab references to the HTML elements we'll need to read from / write to.
const symbolInput = document.getElementById("symbolInput");
const searchBtn = document.getElementById("searchBtn");
const statusMessage = document.getElementById("statusMessage");
const resultsSection = document.getElementById("results");
const stockTitle = document.getElementById("stockTitle");
const priceDisplay = document.getElementById("priceDisplay");
const priceChart = document.getElementById("priceChart");

searchBtn.addEventListener("click", handleSearch);

// Also let the user press Enter in the text box to search.
symbolInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleSearch();
  }
});

async function handleSearch() {
  const query = symbolInput.value.trim();
  if (!query) {
    showStatus("Please enter a company name or ticker symbol.");
    return;
  }

  resultsSection.classList.add("hidden");
  showStatus("Looking up \"" + query + "\"...");

  try {
    // Step 1: turn whatever the user typed ("Apple" or "AAPL") into a
    // real ticker symbol using Alpha Vantage's symbol search.
    const symbolResult = await resolveSymbol(query);
    const symbol = symbolResult.symbol;
    const cacheNotes = [symbolResult.cacheNote].filter(Boolean);

    // Step 2: get today's price for that symbol.
    showStatus("Fetching price for " + symbol + "...");
    const quoteResult = await fetchQuote(symbol);
    if (quoteResult.cacheNote) cacheNotes.push(quoteResult.cacheNote);

    // Step 3: get the last month of daily closing prices for the chart.
    showStatus("Fetching price history for " + symbol + "...");
    const historyResult = await fetchDailyHistory(symbol);
    if (historyResult.cacheNote) cacheNotes.push(historyResult.cacheNote);

    displayResults(symbol, quoteResult.quote, historyResult.history);
    showStatus(cacheNotes.length > 0 ? "Note: " + cacheNotes.join("; ") : "");
  } catch (error) {
    showStatus(error.message);
  }
}

function showStatus(message) {
  statusMessage.textContent = message;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Alpha Vantage replies with this phrase (in a "Note" or "Information"
// field) whenever you've gone over the free tier's request limits.
function isRateLimitMessage(message) {
  return (
    Boolean(message) &&
    message.toLowerCase().includes("thank you for using alpha vantage")
  );
}

function cacheKeyFor(params) {
  const id = params.symbol || params.keywords;
  return CACHE_KEY_PREFIX + params.function + "_" + id.toUpperCase();
}

function readCache(params) {
  const raw = localStorage.getItem(cacheKeyFor(params));
  return raw ? JSON.parse(raw) : null;
}

function writeCache(params, data) {
  const entry = { timestamp: Date.now(), data: data };
  localStorage.setItem(cacheKeyFor(params), JSON.stringify(entry));
}

function isFresh(cacheEntry, functionName) {
  const maxAge = FRESHNESS_MS[functionName] || 0;
  return Date.now() - cacheEntry.timestamp < maxAge;
}

function minutesAgo(timestamp) {
  return Math.max(1, Math.round((Date.now() - timestamp) / 60000));
}

// Calls a URL, parses the JSON, and throws a helpful error if
// Alpha Vantage reports a problem (it always replies with HTTP 200,
// even for errors, so we have to check the body for error fields).
//
// Returns { data, cacheNote }. cacheNote is null for a normal fresh
// response, or a short explanation string if we served cached data
// instead (either because it was still fresh, or because we hit the
// rate limit and fell back to stale cached data rather than failing).
async function fetchAlphaVantageJson(params) {
  const cached = readCache(params);

  if (cached && isFresh(cached, params.function)) {
    return { data: cached.data, cacheNote: null };
  }

  // Make sure we don't call the API more than once per MIN_REQUEST_GAP_MS.
  const sinceLastRequest = Date.now() - lastRequestTime;
  if (sinceLastRequest < MIN_REQUEST_GAP_MS) {
    await delay(MIN_REQUEST_GAP_MS - sinceLastRequest);
  }

  const url = new URL(ALPHA_VANTAGE_BASE_URL);
  for (const key in params) {
    url.searchParams.set(key, params[key]);
  }
  url.searchParams.set("apikey", ALPHA_VANTAGE_API_KEY);

  const response = await fetch(url);
  lastRequestTime = Date.now();
  const data = await response.json();

  const infoMessage = data["Note"] || data["Information"];

  if (isRateLimitMessage(infoMessage)) {
    if (cached) {
      // Better to show slightly stale data than nothing at all.
      return {
        data: cached.data,
        cacheNote:
          "rate limit reached, showing cached data from " +
          minutesAgo(cached.timestamp) +
          " min ago",
      };
    }
    throw new Error(
      "Alpha Vantage rate limit reached (free tier allows 25 requests/day, " +
      "1 per second). Try again in a minute, or wait until tomorrow."
    );
  }

  if (data["Error Message"] || infoMessage) {
    throw new Error(data["Error Message"] || infoMessage);
  }

  writeCache(params, data);
  return { data: data, cacheNote: null };
}

// Looks up a company name or ticker and returns the best matching
// ticker symbol, e.g. "Apple" -> "AAPL".
async function resolveSymbol(query) {
  const params = { function: "SYMBOL_SEARCH", keywords: query };
  const { data, cacheNote } = await fetchAlphaVantageJson(params);

  const matches = data.bestMatches;
  if (!matches || matches.length === 0) {
    throw new Error("No matching stock found for \"" + query + "\".");
  }

  return { symbol: matches[0]["1. symbol"], cacheNote: cacheNote };
}

// Fetches today's price info for a ticker symbol.
async function fetchQuote(symbol) {
  const params = { function: "GLOBAL_QUOTE", symbol: symbol };
  const { data, cacheNote } = await fetchAlphaVantageJson(params);

  const quote = data["Global Quote"];
  if (!quote || !quote["05. price"]) {
    throw new Error("No price data found for " + symbol + ".");
  }

  return {
    quote: {
      price: parseFloat(quote["05. price"]),
      date: quote["07. latest trading day"],
    },
    cacheNote: cacheNote,
  };
}

// Fetches daily closing prices for a ticker symbol and returns the
// most recent ~1 month of trading days, oldest first.
async function fetchDailyHistory(symbol) {
  const params = { function: "TIME_SERIES_DAILY", symbol: symbol };
  const { data, cacheNote } = await fetchAlphaVantageJson(params);

  const series = data["Time Series (Daily)"];
  if (!series) {
    throw new Error("No price history found for " + symbol + ".");
  }

  // The series object looks like { "2026-07-02": { "4. close": "123.45", ... }, ... }
  // with the dates in no guaranteed order, so we turn it into a sorted array.
  const days = Object.keys(series)
    .sort() // sorts dates oldest to newest since they're in YYYY-MM-DD format
    .map((date) => ({
      date: date,
      close: parseFloat(series[date]["4. close"]),
    }));

  // About 21-22 trading days occur in a month, so grab the last 22 entries.
  const tradingDaysPerMonth = 22;
  return { history: days.slice(-tradingDaysPerMonth), cacheNote: cacheNote };
}

function displayResults(symbol, quote, history) {
  stockTitle.textContent = symbol;
  priceDisplay.textContent =
    "$" + quote.price.toFixed(2) + " (as of " + quote.date + ")";

  drawLineChart(priceChart, history);

  resultsSection.classList.remove("hidden");
}

// Draws a simple line chart of closing prices onto a <canvas>.
// No charting library needed - just basic canvas drawing.
function drawLineChart(canvas, history) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;

  // Clear anything drawn from a previous search.
  ctx.clearRect(0, 0, width, height);

  // Leave space around the edges for price/date labels.
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const closes = history.map((day) => day.close);
  const minPrice = Math.min(...closes);
  const maxPrice = Math.max(...closes);

  // Converts a data point index/price into actual x/y pixel coordinates.
  function xForIndex(index) {
    return padding.left + (index / (history.length - 1)) * chartWidth;
  }
  function yForPrice(price) {
    const ratio = (price - minPrice) / (maxPrice - minPrice || 1);
    return padding.top + chartHeight - ratio * chartHeight;
  }

  // Draw the axis lines.
  ctx.strokeStyle = "#999";
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top);
  ctx.lineTo(padding.left, padding.top + chartHeight);
  ctx.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  ctx.stroke();

  // Draw the price line connecting each day's closing price.
  ctx.strokeStyle = "#0066cc";
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((day, index) => {
    const x = xForIndex(index);
    const y = yForPrice(day.close);
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // Label the lowest and highest price on the y-axis.
  ctx.fillStyle = "#333";
  ctx.font = "12px Arial";
  ctx.textAlign = "right";
  ctx.fillText("$" + maxPrice.toFixed(2), padding.left - 5, padding.top + 5);
  ctx.fillText(
    "$" + minPrice.toFixed(2),
    padding.left - 5,
    padding.top + chartHeight
  );

  // Label the first and last date on the x-axis.
  ctx.textAlign = "left";
  ctx.fillText(
    history[0].date,
    padding.left,
    padding.top + chartHeight + 20
  );
  ctx.textAlign = "right";
  ctx.fillText(
    history[history.length - 1].date,
    padding.left + chartWidth,
    padding.top + chartHeight + 20
  );
}
