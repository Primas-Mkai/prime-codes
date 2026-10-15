# Savanna Trails Tanzania — demo website

A fictional business site built for portfolio purposes. Plain HTML, CSS and JS; no build step. Open `index.html` in a browser.

Files: `index.html`, `styles.css`, `script.js` (menu, FAQ, form), `images/` (for photos).
`Site.dc.html`, `Savanna Trails Mockups.dc.html`, `support.js` and `claude-code-prompt.md` are the original design reference.

## Swapping placeholders for real photos

Each image is a `.placeholder` block. Put photos in `images/`, then either:

- add `style="background-image:url(images/serengeti.jpg);background-size:cover;background-position:center"` to the `.placeholder` element (this overrides the stripe pattern), or
- place an `<img src="images/..." alt="..." style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">` inside it.

Then delete the `.ph-label` span. For the hero, the `.hero-overlay` keeps the text readable over the photo.

## Chat assistant

The chat is the embeddable widget from the `ai-chat-widget` project, loaded by the last lines of `index.html`:
`<script src="http://localhost:3000/widget.js" data-business="savanna-trails" defer></script>` (`data-business` picks the business; for the live site use `https://prime-codes.onrender.com/widget.js`).
Open the page through a web address allowed by the server's `ALLOWED_ORIGINS` (for example `http://localhost:5500`), not a `file://` address.
The server must be running on port 3000, otherwise the chat will not appear or reply.
