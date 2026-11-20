# Menos Pay: fictional demo website

A marketing site for "Menos Pay", a made-up Tanzanian payments company, built as a portfolio demo. Plain HTML, CSS and JavaScript: no framework, no build step, no dependencies. It processes no real payments and collects no personal data (there are no forms).

All business facts (products, fees, limits, glossary, FAQ answers) come from `ai-chat-widget/businesses/menospay/info.txt`, the same file the chat assistant uses.

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `styles.css` | Styles (mobile first, layout changes at 900px) |
| `script.js` | Menu, fee calculator wiring, footer year, the "Try the demo assistant" hint |
| `fees.js` | The fee calculation, a pure function used by the page and by the tests |
| `test-fees.js` | Tests for `fees.js`: `node test-fees.js` |
| `check-site.js` | Safety checks before pushing: `node check-site.js` |

## Open it locally

Open the folder with VS Code Live Server (port 5500, which is already in `ALLOWED_ORIGINS`), or any static server on an allowed address. The chat widget only loads on a web address the chat server allows, not from a `file://` address.

### Testing the chat against a local server

In `index.html`, temporarily change the last script tag to:

```html
<script src="http://localhost:3000/widget.js" data-business="menospay" defer></script>
```

Start the chat server (`node server.js` in `ai-chat-widget`, port 3000) and open the page from `http://localhost:5500`.
**Change it back to `https://prime-codes.onrender.com/widget.js` before you push.** `check-site.js` fails if `localhost` is left in the page, so run it before every push.

## The chat assistant

The last line of `index.html` loads the embeddable widget from the prime-codes chat server. The widget has no way to be opened from a page button, so "Try the demo assistant" scrolls to the bottom of the page and shows a short hint pointing at the chat button in the corner.

The chat button will only appear on the live site after the chat server **with the lead-capture changes** has been deployed to Render. Render's free plan also puts the server to sleep, so the first load can take up to a minute.

## Deploy as a Render Static Site

1. In Render, create a new **Static Site** from the same repository, `prime-codes`.
2. **Root directory:** `menospay`
3. **Publish directory:** `.` (a dot)
4. **Build command:** leave empty
5. After it deploys, copy its exact address (no path, no trailing slash, for example `https://your-site.onrender.com`) and add it to `ALLOWED_ORIGINS` on the prime-codes **Web Service**, then redeploy that service. Without this, the chat widget will not load on the live site.

## Checks

```
node test-fees.js
node check-site.js
```
