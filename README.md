# Ramp Manufacturing Co. — Website

Marketing site for **Ramp Manufacturing Co.**, an industrial metal supply house
(carbon & alloy steel, stainless, aluminum, copper & brass, structural) with
in-house processing and just-in-time delivery.

## Stack

Plain static site — no build step. HTML + a single CSS design system + a small
vanilla-JS file. Deploys to Vercel with zero configuration.

```
.
├── index.html        # Home
├── materials.html    # Materials & inventory
├── services.html     # Processing & services
├── about.html        # About / company
├── support.html      # Support, quote form & FAQ
├── css/styles.css    # Design system
├── js/main.js        # Nav, reveal, FAQ, contact form
└── assets/favicon.svg
```

## Local preview

Any static server works, e.g.:

```bash
npx serve .
# or
python -m http.server 3000
```

Then open http://localhost:3000.

## Contact form

The support form (`support.html`) is backend-free: on submit it composes a
prefilled email to **support@rampmanufacturing.co** via the visitor's mail
client. To capture submissions server-side instead, wire the form to a handler
such as a Vercel Function, Formspree, or a form service and remove the
`mailto` fallback in `js/main.js`.

## Deploy

Connected to Vercel via GitHub — every push to `main` triggers a deploy.
Custom domain: **rampmanufacturing.co**.
