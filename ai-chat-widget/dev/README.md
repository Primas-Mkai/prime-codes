# Widget dev setup (mock server)

Try the chat widget's lead confirm card with no Gemini key, no Render and no internet. `dev/` is outside `public/`, so the real server never serves it.

## Run it (Windows PowerShell)

```powershell
node dev/mock-server.js
```

Open <http://localhost:4100>, click the chat button, and type a message that contains the word **lead** (for example `I want a demo, lead please`). The mock answers with a confirm card. Any other message gets "This is a mock reply."

To choose what `POST /api/lead` answers, set `MOCK_LEAD_RESULT` and restart:

```powershell
$env:MOCK_LEAD_RESULT="notconfigured"; node dev/mock-server.js
```

| `MOCK_LEAD_RESULT` | Mock answers | What the card should do |
|---|---|---|
| `ok` (default) | 200 `{ ok: true }` | Buttons are replaced by "Thank you. The team will get back to you on weekdays." and the card is locked |
| `invalid` | 400, field `email` | "Please check the email: is not a valid email address." Only **Edit** is enabled |
| `rate` | 429 with `Retry-After` | "Too many submissions right now. Please try again later." **Send** is enabled again |
| `notconfigured` | 501 | "Sending is not set up yet in this demo, so nothing was sent." Card locked, never a success message |
| `fail` | 502 | "Could not send your details. Please try again." **Send** and **Edit** enabled |
| `slow` | 200 after 3 seconds | Send shows "Sending..." and both buttons are disabled; a double click sends only once |

Other pages and messages:

- <http://localhost:4100/plain.html> uses a business **without** lead capture. A message containing `lead` must show only the normal reply, no card.
- A message containing `xss` returns a lead with HTML in its fields. It must be shown as plain text.

## Manual checklist

1. Card shows "Check your details", only the filled fields (no Phone row here), **Send**, **Edit**, and "Your details will be passed to the Menos Pay team. Please do not share passwords or payment details."
2. Typing in the chat box still works while the card is on screen, and the card does not take the keyboard focus when it appears.
3. Ask for a second card: the first card turns grey and its buttons are disabled.
4. **Edit**: the card locks, the assistant says "Sure. Tell me what to change and I will show the details again.", and the cursor is in the message box.
5. Try each `MOCK_LEAD_RESULT` above, including a double click on **Send** in `slow` mode.
6. Stop the mock server after the card appears, then press **Send**: "Could not send your details. Please try again." and both buttons come back.
7. Tab to **Send** and **Edit** with the keyboard: both show a visible outline. Resize the window to 360 px wide: nothing overflows.

## Automatic checks

```powershell
node test-widget-lead.js
```

Starts the mock server in-process, checks `widget.js`, and (if Chrome or Edge is installed) drives the card in a headless browser for every outcome.
